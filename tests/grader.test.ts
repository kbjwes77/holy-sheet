// The web grader: CLI output parsing, and the server driving a real CLI subprocess.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedScore, keyToString } from "../gen/dummy.ts";
import { makeFixture } from "../gen/fixture.ts";
import { csvRow, parseCsv } from "../src/csv.ts";
import { debugImageName, keyErrorLine, keyPrompt, StderrParser, summarizeStderr, type StderrEvent } from "../src/report.ts";
import { duplicateNames, parseReviewReply, reviewPrompt, reviewReply, reviewStartLine, type AnswerItem, type NameItem, type ReviewItem } from "../src/review.ts";
import { createGraderApi, type JobEvent } from "../web/grader-api.ts";

describe("csv parsing", () => {
    test("round-trips what csvRow writes", () => {
        const rows = [
            ["student_name", "score", "total", "percent"],
            ['Dwayne "The Rock" Johnson', "3", "4", "75.0"],
            ["O'Brien, Liam", "0", "4", "0.0"],
            ["Line\nbreak", "", "4", "1"],
        ];
        expect(parseCsv(rows.map(csvRow).join(""))).toEqual(rows);
    });
    test("LF endings, no trailing newline, empty input", () => {
        expect(parseCsv("a,b\nc,d")).toEqual([
            ["a", "b"],
            ["c", "d"],
        ]);
        expect(parseCsv("")).toEqual([]);
        expect(() => parseCsv('"open')).toThrow(/unterminated/);
    });
});

describe("stderr parsing", () => {
    const run = (chunks: string[]) => {
        const p = new StderrParser();
        return [...chunks.flatMap((c) => p.push(c)), ...p.end()];
    };
    const prompt = keyPrompt(12);

    test("progress lines, a split prompt, a rejected then accepted key", () => {
        const events = run([
            "decoded 1/2: a.jpg\ndecoded 2/2: b",
            ".jpg (problem)\n",
            prompt.slice(0, 10),
            prompt.slice(10),
            keyErrorLine("the key has 2 entries, but the test has 12 questions"),
            prompt,
            "skipped submission [b.jpg]:\n  - b.jpg: QR code not found\n",
            "graded 1, skipped 1 submission(s) from sheets.zip\n",
        ]);
        expect(events).toEqual<StderrEvent[]>([
            { type: "log", text: "decoded 1/2: a.jpg" },
            { type: "log", text: "decoded 2/2: b.jpg (problem)" },
            { type: "prompt", questions: 12 },
            { type: "keyError", text: "the key has 2 entries, but the test has 12 questions" },
            { type: "prompt", questions: 12 },
            { type: "keyAccepted" },
            { type: "log", text: "skipped submission [b.jpg]:" },
            { type: "log", text: "  - b.jpg: QR code not found" },
            { type: "log", text: "graded 1, skipped 1 submission(s) from sheets.zip" },
        ]);
    });

    test("prompt and the next line in one chunk; stdin closed", () => {
        expect(run([`${prompt}graded 2, skipped 0 submission(s) from x.zip\n`])).toEqual<StderrEvent[]>([
            { type: "prompt", questions: 12 },
            { type: "keyAccepted" },
            { type: "log", text: "graded 2, skipped 0 submission(s) from x.zip" },
        ]);
        expect(run([prompt])).toEqual<StderrEvent[]>([{ type: "prompt", questions: 12 }, { type: "keyAccepted" }]);
    });

    test("review prompts back to back, a rejected reply, then the next log line", () => {
        const name: NameItem = { kind: "name", id: 1, submission: 0, image: "name-1.png", files: ["a.jpg", "b.jpg"], ocr: "Jo > Smith" };
        const q: AnswerItem = {
            kind: "answer",
            id: 2,
            submission: 0,
            image: "q-2.png",
            file: "a.jpg",
            question: 7,
            choices: 4,
            marked: [0],
            unclear: [2],
            fills: [0.9, 0, 0.31, 0],
            verdicts: ["marked", "blank", "ambiguous", "blank"],
            width: 1,
            height: 1,
            rings: [],
        };
        const p1 = reviewPrompt(name, 2);
        const p2 = reviewPrompt(q, 2);
        expect(p1).not.toContain("Jo > Smith");
        const events = run([reviewStartLine(2, "dir/review"), p1.slice(0, 20), p1.slice(20) + p2, keyErrorLine('"Z" is not a choice'), p2, "graded 1\n"]);
        expect(events).toEqual<StderrEvent[]>([
            { type: "log", text: "review: 2 item(s) to check, images in dir/review" },
            { type: "reviewPrompt", item: 1, total: 2 },
            { type: "reviewPrompt", item: 2, total: 2 },
            { type: "reviewError", item: 2, text: '"Z" is not a choice' },
            { type: "reviewPrompt", item: 2, total: 2 },
            { type: "log", text: "graded 1" },
        ]);
        expect(summarizeStderr(["review: 2 item(s) to check, images in dir/review"]).reviewDir).toBe("dir/review");
    });

    test("summarizes progress, skipped submissions, debug dir and fatal errors", () => {
        const s = summarizeStderr([
            "decoded 1/3: p1.jpg",
            "decoded 2/3: dir/p2.jpg (problem)",
            "skipped submission [p1.jpg, dir/p2.jpg]:",
            "  - dir/p2.jpg: QR code not found",
            "  - missing page(s) 2",
            "skipped orphan pages [p3.jpg]:",
            "  - orphan",
            "wrote 3 diagnostic image(s) to C:\\tmp\\grade-2026",
            "graded 0, skipped 1 submission(s) and 1 group(s) of orphan pages from s.zip",
        ]);
        expect(s).toEqual({
            decoded: 2,
            pages: 3,
            problemFiles: ["dir/p2.jpg"],
            skipped: [
                { orphan: false, files: ["p1.jpg", "dir/p2.jpg"], reasons: ["dir/p2.jpg: QR code not found", "missing page(s) 2"] },
                { orphan: true, files: ["p3.jpg"], reasons: ["orphan"] },
            ],
            debugDir: "C:\\tmp\\grade-2026",
            totals: "graded 0, skipped 1 submission(s) and 1 group(s) of orphan pages from s.zip",
        });
        expect(summarizeStderr(["fatal: the zip contains no JPEG or PNG images"]).fatal).toBe("the zip contains no JPEG or PNG images");
        expect(debugImageName("dir/p2.jpg")).toBe("dir_p2.png");
    });
});

describe("review replies", () => {
    const name = (ocr: string | null): NameItem => ({ kind: "name", id: 1, submission: 0, image: "", files: ["a.jpg"], ocr });
    const q: AnswerItem = { kind: "answer", id: 2, submission: 0, image: "", file: "a.jpg", question: 1, choices: 3, marked: [], unclear: [1], fills: [0, 0.3, 0], verdicts: ["blank", "ambiguous", "blank"], width: 1, height: 1, rings: [] };

    test("names: Enter keeps the OCR, text replaces it, - skips", () => {
        expect(parseReviewReply(name("Jane Doe"), "")).toEqual({ decision: { name: "Jane Doe" } });
        expect(parseReviewReply(name("Jane Doe"), "  Jayne   Doe ")).toEqual({ decision: { name: "Jayne Doe" } });
        expect(parseReviewReply(name(null), "")).toHaveProperty("error");
        expect(parseReviewReply(name(null), "-")).toEqual({ decision: { skip: true } });
    });

    test("answers: letters, none, out of range", () => {
        expect(parseReviewReply(q, "cb")).toEqual({ decision: { answer: [1, 2] } });
        expect(parseReviewReply(q, "NONE")).toEqual({ decision: { answer: [] } });
        expect(parseReviewReply(q, "D")).toHaveProperty("error");
        expect(parseReviewReply(q, "")).toHaveProperty("error");
        for (const d of [{ answer: [0, 2] }, { answer: [] }, { skip: true as const }]) expect(parseReviewReply(q, reviewReply(d))).toEqual({ decision: d });
    });

    test("duplicate names ignore case and spacing", () => {
        const dups = duplicateNames([
            { name: "Jane Doe", file: "a.jpg" },
            { name: "jane doe ", file: "c.jpg" },
            { name: "Liam Chen", file: "e.jpg" },
        ]);
        expect([...dups]).toEqual([["jane doe", ["a.jpg", "c.jpg"]]]);
    });
});

/** Reads a server-sent event stream until `done`, calling `on` for each event. */
async function readEvents(res: Response, on: (e: JobEvent) => Promise<void> | void): Promise<JobEvent[]> {
    const events: JobEvent[] = [];
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("event stream ended before done");
        buf += value;
        let end: number;
        while ((end = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, end);
            buf = buf.slice(end + 2);
            const data = block.split("\n").find((l) => l.startsWith("data: "));
            if (!data) continue;
            const e = JSON.parse(data.slice(6)) as JobEvent;
            events.push(e);
            await on(e);
            if (e.type === "done") {
                await reader.cancel();
                return events;
            }
        }
    }
}

const root = join(import.meta.dir, "..");

function serve(api: ReturnType<typeof createGraderApi>) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: api.routes });
    return {
        url: (p: string) => new URL(p, server.url).href,
        stop() {
            server.stop(true);
            api.shutdown();
        },
    };
}

describe("grader server", () => {
    test(
        "runs the CLI on an upload, relays the key prompt, returns its CSV and diagnostic images",
        async () => {
            const fx = await makeFixture({ seed: 77, students: 3, questions: 12, profiles: ["scan"], duplicatePageOf: 1 });
            const zip = new Blob([fx.zip as BlobPart]);
            const dir = mkdtempSync(join(tmpdir(), "grader-web-"));
            const names = Object.fromEntries(fx.files.filter((f) => f.student >= 0).map((f) => [f.name, fx.students[f.student]!.name]));
            writeFileSync(join(dir, "names.json"), JSON.stringify(names));

            const { url, stop } = serve(
                createGraderApi({
                    root,
                    command: [process.execPath, join(import.meta.dir, "helpers", "mock-ocr-cli.ts")],
                    env: { ...process.env, MOCK_NAMES: join(dir, "names.json") },
                }),
            );
            try {
                const info = await (await fetch(url("/api/grader/info"))).json();
                expect(info.thresholds).toEqual({ markThreshold: 0.45, blankThreshold: 0.15 });

                const cross = await fetch(url("/api/grader/jobs?name=x.zip"), { method: "POST", body: zip, headers: { origin: "https://evil.example" } });
                expect(cross.status).toBe(403);
                expect((await fetch(url("/api/grader/jobs?mark=abc"), { method: "POST", body: zip })).status).toBe(400);

                const created = await fetch(url("/api/grader/jobs?name=period 3.zip&mark=0.45"), { method: "POST", body: zip });
                expect(created.status).toBe(201);
                const { id } = (await created.json()) as { id: string };
                expect((await fetch(url(`/api/grader/jobs/${id}/input`), { method: "POST", body: "A" })).status).toBe(409);

                let prompts = 0;
                const events = await readEvents(await fetch(url(`/api/grader/jobs/${id}/events`)), async (e) => {
                    if (e.type !== "prompt") return;
                    // A wrong key first: the CLI rejects it and asks again.
                    const key = ++prompts === 1 ? "A,B" : keyToString(fx.dummy.key);
                    expect((await fetch(url(`/api/grader/jobs/${id}/input`), { method: "POST", body: key })).status).toBe(204);
                });

                expect(events[0]).toEqual({ type: "start", command: 'bun run grade.ts "period 3.zip" --mark 0.45' });
                expect(events.filter((e) => e.type === "keyError")).toEqual([
                    { type: "keyError", text: "the key has 2 entries, but the test has 12 questions" },
                ]);
                expect(events.some((e) => e.type === "keyAccepted")).toBe(true);
                const done = events.at(-1) as Extract<JobEvent, { type: "done" }>;
                expect(done.exitCode).toBe(2);
                const expected = fx.expected.map((e) => [e.name, String(e.score), String(e.total), ((e.score / e.total) * 100).toFixed(1)]);
                expect(parseCsv(done.csv)).toEqual([["student_name", "score", "total", "percent"], ...expected]);

                const log = events.flatMap((e) => (e.type === "log" ? [e.text] : []));
                const summary = summarizeStderr(log);
                expect(summary.skipped).toHaveLength(1);
                expect(summary.skipped[0]!.reasons.join()).toMatch(/duplicate page/);
                expect(summary.totals).toMatch(/graded 2, skipped 1 submission\(s\) from period 3\.zip/);

                // Problem pages' diagnostic images are served, and nothing outside the list is.
                expect(done.images.length).toBeGreaterThan(0);
                expect(done.images).toContain(debugImageName(summary.skipped[0]!.files[0]!));
                const img = await fetch(url(`/api/grader/jobs/${id}/images/${encodeURIComponent(done.images[0]!)}`));
                expect(img.headers.get("content-type")).toBe("image/png");
                expect([...(await img.bytes()).subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
                expect((await fetch(url(`/api/grader/jobs/${id}/images/..%2Fperiod%203.zip`))).status).toBe(404);
                expect((await fetch(url(`/api/grader/jobs/${id}/images.zip`))).headers.get("content-type")).toBe("application/zip");

                // A late subscriber gets the whole run replayed.
                const replay = await readEvents(await fetch(url(`/api/grader/jobs/${id}/events`)), () => {});
                expect(replay).toEqual(events);
            } finally {
                stop();
                rmSync(dir, { recursive: true, force: true });
            }
        },
        300_000,
    );

    test(
        "review: unclear marks are decided, names kept or corrected, a submission skipped",
        async () => {
            // Every student has one faint mark, which used to skip every submission.
            const fx = await makeFixture({ seed: 31, students: 3, questions: 12, profiles: ["scan"], ambiguousRate: 1 });
            expect(fx.students.every((s) => s.hasAmbiguous)).toBe(true);
            const zip = new Blob([fx.zip as BlobPart]);
            const dir = mkdtempSync(join(tmpdir(), "grader-web-"));
            const studentOf = new Map(fx.files.map((f) => [f.name, f.student]));
            const names = Object.fromEntries(fx.files.filter((f) => f.pageNumber === 1).map((f) => [f.name, fx.students[f.student]!.name]));
            writeFileSync(join(dir, "names.json"), JSON.stringify(names));

            const { url, stop } = serve(
                createGraderApi({
                    root,
                    command: [process.execPath, join(import.meta.dir, "helpers", "mock-ocr-cli.ts")],
                    env: { ...process.env, MOCK_NAMES: join(dir, "names.json") },
                }),
            );
            try {
                const { id } = (await (await fetch(url("/api/grader/jobs?name=p1.zip&review=1"), { method: "POST", body: zip })).json()) as { id: string };
                let items: ReviewItem[] = [];
                let rejected = false;
                const events = await readEvents(await fetch(url(`/api/grader/jobs/${id}/events`)), async (e) => {
                    if (e.type === "prompt") {
                        const key = (at: string) => fetch(url(`/api/grader/jobs/${id}/input?at=${at}`), { method: "POST", body: fx.key });
                        expect((await key("1")).status).toBe(409);
                        expect((await key("key")).status).toBe(204);
                    }
                    if (e.type === "review") items = e.items;
                    if (e.type !== "reviewPrompt") return;
                    const item = items.find((i) => i.id === e.item)!;
                    let reply: string;
                    if (item.kind === "name") {
                        // Keep the first student's name, correct the second, skip the third.
                        reply = ["", "Renamed Student", "-"][item.submission]!;
                    } else if (!rejected) {
                        rejected = true;
                        reply = "Z";
                    } else {
                        // What the student meant: their intended answer.
                        const student = fx.students[studentOf.get(item.file)!]!;
                        reply = reviewReply({ answer: student.responses[item.question - 1]!.chosen });
                    }
                    // A reply naming another item (say, a late duplicate) is refused.
                    const post = (n: number) => fetch(url(`/api/grader/jobs/${id}/input?at=${n}`), { method: "POST", body: reply });
                    expect((await post(e.item + 1)).status).toBe(409);
                    expect((await post(e.item)).status).toBe(204);
                });

                expect(events[0]).toEqual({ type: "start", command: "bun run grade.ts p1.zip --review" });
                const kinds = items.map((i) => i.kind);
                expect(kinds.filter((k) => k === "name")).toHaveLength(3);
                expect(kinds.filter((k) => k === "answer").length).toBeGreaterThanOrEqual(3);
                // The page colors each choice by the run's thresholds; every unclear choice reads as such.
                expect(events.find((e) => e.type === "review")).toMatchObject({ thresholds: { mark: 0.45, blank: 0.15 } });
                for (const i of items) if (i.kind === "answer") for (const c of i.unclear) expect(i.verdicts[c]).toBe("ambiguous");
                expect(events.filter((e) => e.type === "reviewError")).toHaveLength(1);
                // The skipped submission's own items aren't asked.
                const asked = new Set(events.flatMap((e) => (e.type === "reviewPrompt" ? [e.item] : [])));
                expect(items.filter((i) => i.submission === 2).map((i) => asked.has(i.id))).toEqual(items.filter((i) => i.submission === 2).map((i) => i.kind === "name"));

                const done = events.at(-1) as Extract<JobEvent, { type: "done" }>;
                expect(done.exitCode).toBe(2);
                // Scored on the intended answers (fx.expected leaves out students with unclear marks).
                const row = (i: number, name: string) => {
                    const score = expectedScore(fx.students[i]!, fx.dummy);
                    return [name, String(score), "12", ((score / 12) * 100).toFixed(1)];
                };
                expect(parseCsv(done.csv)).toEqual([["student_name", "score", "total", "percent"], row(0, fx.students[0]!.name), row(1, "Renamed Student")]);
                const log = events.flatMap((e) => (e.type === "log" ? [e.text] : []));
                const third = items.find((i): i is NameItem => i.kind === "name" && i.submission === 2)!;
                expect(summarizeStderr(log).skipped).toEqual([{ orphan: false, files: third.files, reasons: ["skipped during review"] }]);

                // Review crops are served; nothing else from that directory is.
                const img = await fetch(url(`/api/grader/jobs/${id}/review/${items[1]!.image}`));
                expect(img.headers.get("content-type")).toBe("image/png");
                expect((await fetch(url(`/api/grader/jobs/${id}/review/review.json`))).status).toBe(404);
            } finally {
                stop();
                rmSync(dir, { recursive: true, force: true });
            }
        },
        300_000,
    );

    test("cancelling a run kills the CLI and reports it", async () => {
        // A stand-in CLI that waits at the key prompt forever.
        const script = `process.stderr.write(${JSON.stringify(keyPrompt(3))}); setInterval(() => {}, 1000);`;
        const { url, stop } = serve(createGraderApi({ root, command: [process.execPath, "-e", script] }));
        try {
            const res = await fetch(url("/api/grader/jobs"), { method: "POST", body: new Uint8Array([1]) });
            const { id } = (await res.json()) as { id: string };
            const events = await readEvents(await fetch(url(`/api/grader/jobs/${id}/events`)), async (e) => {
                if (e.type === "prompt") await fetch(url(`/api/grader/jobs/${id}/cancel`), { method: "POST" });
            });
            expect(events.at(-1)).toMatchObject({ type: "done", cancelled: true, exitCode: null });
        } finally {
            stop();
        }
    }, 30_000);
});
