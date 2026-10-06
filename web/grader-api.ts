// HTTP bridge that lets the web grader page drive the grader CLI. Each upload becomes a job: the
// zip (and the test's JSON, when uploaded too) is written to a fresh temp directory and
// `bun grade.ts <zip> [--test <json>] [flags]` runs on it as a subprocess, exactly as from a
// terminal. The CLI's stderr streams to the page as server-sent
// events (progress, the key and review prompts, skipped submissions), the page's replies are
// written to its stdin, and its stdout (the CSV) goes to the page when it exits. Diagnostic
// images and review crops the CLI writes next to the zip are served from there.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { zipSync } from "fflate";
import { DEFAULT_THRESHOLDS } from "../src/pipeline.ts";
import { StderrParser, summarizeStderr, type StderrEvent } from "../src/report.ts";
import { REVIEW_FILE, REVIEW_START_RE, type ReviewFile, type ReviewItem, type ReviewThresholds } from "../src/review.ts";

export type JobEvent =
    | StderrEvent
    | { type: "start"; command: string }
    | { type: "review"; thresholds: ReviewThresholds; items: ReviewItem[] }
    | { type: "done"; exitCode: number | null; cancelled: boolean; csv: string; images: string[] };

interface Job {
    id: string;
    dir: string;
    proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    events: JobEvent[];
    listeners: Set<(e: JobEvent, id: number) => void>;
    /** A prompt (key or review) is waiting for a reply. */
    awaitingInput: boolean;
    /** The prompt waiting ("key" or a review item), so a late or repeated reply can't answer another. */
    waitingAt: string | null;
    cancelled: boolean;
    done: boolean;
    images: string[];
    debugDir?: string;
    review?: { dir: string; images: Set<string> };
}

export interface GraderApiOptions {
    /** Project root: the CLI runs here, so it picks up `.env`. */
    root: string;
    /** CLI argv before the zip path (tests swap in a CLI with mocked OCR). */
    command?: string[];
    env?: Record<string, string | undefined>;
    /** How long a finished job's results and files are kept. */
    keepMs?: number;
}

const OCR_VARS = ["OPENROUTER_API_KEY", "OPENROUTER_MODEL"] as const;
const RATIO = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Upload name → a safe file name ending in `ext` (the zip's is shown in the CLI's summary line). */
function safeName(raw: string | null, ext: string, fallback: string): string {
    const base = basename((raw ?? "").replace(/\\/g, "/"))
        .replace(/[^\w.\- ]+/g, "_")
        .replace(/^\.+/, "")
        .slice(0, 100);
    if (!base) return fallback;
    return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
}
const zipName = (raw: string | null) => safeName(raw, ".zip", "sheets.zip");

/** The most test JSON accepted: figures can be large, but not this large. */
const MAX_TEST_BYTES = 8 * 1024 * 1024;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

/** POSTs from other sites (a page can post to localhost) are refused. */
function sameOrigin(req: Request): boolean {
    const origin = req.headers.get("origin");
    return !origin || origin === new URL(req.url).origin;
}

export function createGraderApi(o: GraderApiOptions) {
    const env = o.env ?? process.env;
    const command = o.command ?? [process.execPath, join(o.root, "grade.ts")];
    const keepMs = o.keepMs ?? 2 * 60 * 60 * 1000;
    const jobs = new Map<string, Job>();

    function emit(job: Job, e: JobEvent): void {
        job.events.push(e);
        for (const l of job.listeners) l(e, job.events.length - 1);
    }

    function remove(job: Job): void {
        if (!job.done) job.proc.kill();
        jobs.delete(job.id);
        rmSync(job.dir, { recursive: true, force: true });
    }

    /** A directory the CLI reported, if it is the given depth inside the job's directory. */
    function insideJob(job: Job, dir: string, depth: number): string | undefined {
        const abs = resolve(o.root, dir);
        const parts = relative(job.dir, abs).split(sep);
        return parts.length === depth && parts.every((p) => p && p !== "..") ? abs : undefined;
    }

    async function run(job: Job): Promise<void> {
        const parser = new StderrParser();
        const log: string[] = [];
        const handle = (events: StderrEvent[]) => {
            for (const e of events) {
                if (e.type === "log") log.push(e.text);
                if (e.type === "prompt" || e.type === "keyError" || e.type === "reviewPrompt" || e.type === "reviewError") job.awaitingInput = true;
                if (e.type === "keyAccepted") job.awaitingInput = false;
                if (e.type === "prompt") job.waitingAt = "key";
                if (e.type === "reviewPrompt") job.waitingAt = String(e.item);
                emit(job, e);
                const review = e.type === "log" && REVIEW_START_RE.exec(e.text);
                if (review) loadReview(job, review[2]!);
            }
        };
        const stdout = new Response(job.proc.stdout).text();
        const decoder = new TextDecoder();
        for await (const chunk of job.proc.stderr) handle(parser.push(decoder.decode(chunk, { stream: true })));
        handle(parser.push(decoder.decode()));
        handle(parser.end());
        const exitCode = await job.proc.exited;
        const csv = await stdout;

        // Only serve a debug directory the CLI created inside this job's directory.
        const dir = summarizeStderr(log).debugDir;
        if (dir) {
            const abs = insideJob(job, dir, 1);
            if (abs) {
                job.debugDir = abs;
                job.images = readdirSync(abs)
                    .filter((f) => f.toLowerCase().endsWith(".png"))
                    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            }
        }
        job.done = true;
        job.awaitingInput = false;
        emit(job, { type: "done", exitCode: job.cancelled ? null : exitCode, cancelled: job.cancelled, csv, images: job.images });
        setTimeout(() => remove(job), keepMs).unref?.();
    }

    /** Sends the review items to the page once the CLI has written them (grade-<time>/review). */
    function loadReview(job: Job, dir: string): void {
        const abs = insideJob(job, dir, 2);
        if (!abs) return;
        const file = JSON.parse(readFileSync(join(abs, REVIEW_FILE), "utf8")) as ReviewFile;
        job.review = { dir: abs, images: new Set(file.items.map((i) => i.image)) };
        emit(job, { type: "review", thresholds: file.thresholds, items: file.items });
    }

    /**
     * Starts a job. The body is the zip, or a multipart form with the zip (`zip`) and the test's
     * JSON (`test`), which the CLI then grades with (`--test`).
     */
    async function create(req: Request): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const url = new URL(req.url);
        let zip: Uint8Array;
        let test: { name: string; bytes: Uint8Array } | null = null;
        if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
            let form: FormData;
            try {
                form = await req.formData();
            } catch {
                return fail(400, "the upload isn't a valid form");
            }
            const z = form.get("zip");
            const t = form.get("test");
            if (!(z instanceof Blob)) return fail(400, "no zip uploaded");
            zip = new Uint8Array(await z.arrayBuffer());
            if (t instanceof Blob) {
                if (t.size > MAX_TEST_BYTES) return fail(400, "the test JSON is too large");
                test = { name: safeName(t instanceof File ? t.name : null, ".json", "test.json"), bytes: new Uint8Array(await t.arrayBuffer()) };
            } else if (t !== null) return fail(400, "the test JSON must be a file");
        } else zip = new Uint8Array(await req.arrayBuffer());
        if (!zip.length) return fail(400, "no zip uploaded");

        const name = zipName(url.searchParams.get("name"));
        const args: string[] = [];
        for (const flag of ["mark", "blank"] as const) {
            const v = url.searchParams.get(flag);
            if (v === null || v === "") continue;
            if (!RATIO.test(v)) return fail(400, `--${flag} must be a number between 0 and 1`);
            args.push(`--${flag}`, v);
        }
        if (url.searchParams.get("debug") === "1") args.push("--debug");
        if (url.searchParams.get("review") === "1") args.push("--review");

        const dir = mkdtempSync(join(tmpdir(), "quiznotes-grade-"));
        const zipPath = join(dir, name);
        writeFileSync(zipPath, zip);
        if (test) {
            // In a folder of its own, so its name can't collide with the zip's.
            mkdirSync(join(dir, "test"));
            const testPath = join(dir, "test", test.name);
            writeFileSync(testPath, test.bytes);
            args.unshift("--test", testPath);
        }
        const proc = Bun.spawn([...command, zipPath, ...args], {
            cwd: o.root,
            env: { ...env },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        const id = crypto.randomUUID();
        const job: Job = { id, dir, proc, events: [], listeners: new Set(), awaitingInput: false, waitingAt: null, cancelled: false, done: false, images: [] };
        jobs.set(id, job);
        // The command as the user would type it: the test by its own name, not its temp path.
        const shown = test ? ["--test", test.name, ...args.slice(2)] : args;
        emit(job, { type: "start", command: ["bun run grade.ts", ...[name, ...shown].map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" ") });
        void run(job).catch((e) => {
            job.done = true;
            emit(job, { type: "log", text: `fatal: web grader: ${(e as Error).message}` });
            emit(job, { type: "done", exitCode: 1, cancelled: false, csv: "", images: [] });
        });
        return json({ id }, 201);
    }

    function events(req: Request, job: Job, server: Bun.Server<unknown>): Response {
        server.timeout(req, 0);
        // EventSource reconnects with Last-Event-ID; replay everything after it.
        const from = Number(req.headers.get("last-event-id") ?? -1) + 1;
        const enc = new TextEncoder();
        let cleanup = () => {};
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const send = (e: JobEvent, id: number) => {
                    try {
                        controller.enqueue(enc.encode(`id: ${id}\ndata: ${JSON.stringify(e)}\n\n`));
                    } catch {
                        cleanup();
                    }
                };
                job.events.slice(from).forEach((e, i) => send(e, from + i));
                job.listeners.add(send);
                const ping = setInterval(() => {
                    try {
                        controller.enqueue(enc.encode(": ping\n\n"));
                    } catch {
                        cleanup();
                    }
                }, 15_000);
                cleanup = () => {
                    clearInterval(ping);
                    job.listeners.delete(send);
                };
                req.signal.addEventListener("abort", cleanup);
            },
            cancel: () => cleanup(),
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }

    /**
     * Writes one line to the CLI's stdin, answering the prompt it is waiting at. A reply may name
     * the prompt it answers (`?at=key` or `?at=<review item>`), and is then refused unless that
     * prompt is the one waiting, so a retried request can't answer a later prompt.
     */
    async function input(req: Request, job: Job): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const at = new URL(req.url).searchParams.get("at");
        const line = (await req.text()).replace(/[\r\n]+/g, " ").trim();
        // Checked after reading the body, so of two replies in flight only one gets through.
        if (!job.awaitingInput) return fail(409, "the grader isn't waiting for input");
        if (at !== null && at !== job.waitingAt) return fail(409, `the grader isn't waiting at ${at}`);
        job.awaitingInput = false;
        job.proc.stdin.write(`${line}\n`);
        job.proc.stdin.flush();
        return new Response(null, { status: 204 });
    }

    function cancel(req: Request, job: Job): Response {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        if (!job.done) {
            job.cancelled = true;
            job.proc.kill();
        }
        return new Response(null, { status: 204 });
    }

    function image(job: Job, name: string): Response {
        if (!job.debugDir || !job.images.includes(name)) return fail(404, "no such image");
        return new Response(Bun.file(join(job.debugDir, name)), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
    }

    function reviewImage(job: Job, name: string): Response {
        if (!job.review?.images.has(name)) return fail(404, "no such image");
        const file = Bun.file(join(job.review.dir, name));
        return new Response(file, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
    }

    async function imagesZip(job: Job): Promise<Response> {
        if (!job.debugDir || !job.images.length) return fail(404, "no diagnostic images");
        const files: Record<string, [Uint8Array, { level: 0 }]> = {};
        for (const f of job.images) files[f] = [await Bun.file(join(job.debugDir, f)).bytes(), { level: 0 }];
        return new Response(zipSync(files), {
            headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="diagnostics.zip"' },
        });
    }

    type Req = Bun.BunRequest<string> & { params: Record<string, string> };
    const withJob =
        (fn: (req: Req, job: Job, server: Bun.Server<unknown>) => Response | Promise<Response>) =>
        (req: Req, server: Bun.Server<unknown>) => {
            const job = jobs.get(req.params.id ?? "");
            return job ? fn(req, job, server) : fail(404, "no such job (finished jobs are kept for a while, then removed)");
        };

    const routes = {
        "/api/grader/info": {
            GET: () =>
                json({
                    missing: OCR_VARS.filter((v) => !env[v]),
                    thresholds: DEFAULT_THRESHOLDS,
                }),
        },
        "/api/grader/jobs": { POST: create },
        "/api/grader/jobs/:id/events": { GET: withJob(events) },
        "/api/grader/jobs/:id/input": { POST: withJob(input) },
        "/api/grader/jobs/:id/cancel": { POST: withJob(cancel) },
        "/api/grader/jobs/:id/images.zip": { GET: withJob((_req, job) => imagesZip(job)) },
        "/api/grader/jobs/:id/images/:name": { GET: withJob((req, job) => image(job, req.params.name ?? "")) },
        "/api/grader/jobs/:id/review/:name": { GET: withJob((req, job) => reviewImage(job, req.params.name ?? "")) },
    };

    return {
        routes,
        /** Kills running CLIs and deletes every job's files. */
        shutdown(): void {
            for (const job of [...jobs.values()]) remove(job);
        },
    };
}
