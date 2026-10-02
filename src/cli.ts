// CLI: bun run grade.ts <sheets.zip> [--debug] [--review] [--mark <ratio>] [--blank <ratio>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { CSV_HEADER, csvRow } from "./csv.ts";
import { renderDebug } from "./debug.ts";
import { ask, KeyAbortError, LineReader, promptKey } from "./key.ts";
import { OpenRouterNameReader, type NameReader } from "./ocr.ts";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./pipeline.ts";
import { debugImageName, debugWrittenLine, skippedHeader, skippedReasonLine } from "./report.ts";
import { parseReviewReply, REVIEW_FILE, reviewPrompt, reviewStartLine, type ReviewDecision, type ReviewFile } from "./review.ts";
import { FatalError, gradeZip, type RunOptions, type RunResult } from "./run.ts";
import { ZipError } from "./zip.ts";

const USAGE = "usage: bun run grade.ts <sheets.zip> [--debug] [--review] [--mark <ratio>] [--blank <ratio>]";

function timestampDir(zipPath: string): string {
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    return join(dirname(zipPath), `grade-${ts}`);
}

async function writeDebugImages(result: RunResult, dir: string, all: boolean): Promise<number> {
    const pages = all ? result.pages : result.problemPages;
    if (!pages.length) return 0;
    mkdirSync(dir, { recursive: true });
    for (const p of pages) {
        writeFileSync(join(dir, debugImageName(p.file)), await renderDebug(p));
    }
    return pages.length;
}

/** Writes each item's crop and review.json, then prompts per item. */
function reviewHooks(dir: string, thresholds: Thresholds, lines: LineReader, err: (s: string) => void): NonNullable<RunOptions["review"]> {
    return {
        async begin(items) {
            mkdirSync(dir, { recursive: true });
            for (const { item, png } of items) if (png.length) writeFileSync(join(dir, item.image), png);
            const file: ReviewFile = { thresholds: { mark: thresholds.markThreshold, blank: thresholds.blankThreshold }, items: items.map((i) => i.item) };
            writeFileSync(join(dir, REVIEW_FILE), JSON.stringify(file));
            err(reviewStartLine(items.length, dir));
        },
        async ask(item, total) {
            const prompt = reviewPrompt(item, total);
            const r = await ask<{ decision: ReviewDecision }>(lines, err, prompt, (l) => parseReviewReply(item, l), "review stopped (stdin closed)");
            return r.decision;
        },
    };
}

export interface CliDeps {
    /** Overrides the OpenRouter reader (tests). */
    nameReader?: NameReader;
    env?: Record<string, string | undefined>;
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
    stdin?: NodeJS.ReadableStream;
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
    const out = deps.stdout ?? ((s: string) => process.stdout.write(s));
    const err = deps.stderr ?? ((s: string) => process.stderr.write(s));
    const env = deps.env ?? process.env;

    let args;
    try {
        args = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                debug: { type: "boolean", default: false },
                review: { type: "boolean", default: false },
                mark: { type: "string" },
                blank: { type: "string" },
                help: { type: "boolean", short: "h", default: false },
            },
        });
    } catch (e) {
        err(`${(e as Error).message}\n${USAGE}\n`);
        return 1;
    }
    const zipPath = args.positionals[0];
    if (args.values.help || !zipPath || args.positionals.length > 1) {
        err(USAGE + "\n");
        return args.values.help ? 0 : 1;
    }
    const thresholds = { ...DEFAULT_THRESHOLDS };
    for (const [flag, prop] of [["mark", "markThreshold"], ["blank", "blankThreshold"]] as const) {
        const v = args.values[flag];
        if (v === undefined) continue;
        const n = Number(v);
        if (!(n >= 0 && n <= 1)) {
            err(`--${flag} must be a number between 0 and 1\n`);
            return 1;
        }
        thresholds[prop] = n;
    }
    if (thresholds.blankThreshold > thresholds.markThreshold) {
        err("--blank must not be greater than --mark\n");
        return 1;
    }

    let nameReader = deps.nameReader;
    if (!nameReader) {
        const apiKey = env.OPENROUTER_API_KEY;
        const model = env.OPENROUTER_MODEL;
        const missing = [!apiKey && "OPENROUTER_API_KEY", !model && "OPENROUTER_MODEL"].filter(Boolean);
        if (missing.length) {
            err(`fatal: ${missing.join(" and ")} must be set (e.g. in .env)\n`);
            return 1;
        }
        nameReader = new OpenRouterNameReader({ apiKey: apiKey!, model: model! });
    }

    let zip: Uint8Array;
    try {
        zip = readFileSync(zipPath);
    } catch (e) {
        err(`fatal: cannot read ${zipPath}: ${(e as Error).message}\n`);
        return 1;
    }

    const dir = timestampDir(zipPath);
    const lines = new LineReader(deps.stdin);
    let result: RunResult;
    try {
        result = await gradeZip(zip, {
            nameReader,
            thresholds,
            getKey: (maxChoices) => promptKey(maxChoices, lines, err),
            onProgress: (m) => err(`${m}\n`),
            ...(args.values.review ? { review: reviewHooks(join(dir, "review"), thresholds, lines, err) } : {}),
        });
    } catch (e) {
        if (e instanceof FatalError || e instanceof ZipError || e instanceof KeyAbortError) {
            err(`fatal: ${e.message}\n`);
            return 1;
        }
        throw e;
    } finally {
        lines.dispose();
    }

    out(csvRow(CSV_HEADER));
    for (const r of result.rows) out(csvRow([r.name, r.score, r.total, r.percent]));

    for (const s of result.skipped) {
        err(skippedHeader(s.orphan, s.files));
        for (const r of s.reasons) err(skippedReasonLine(r));
    }
    const written = await writeDebugImages(result, dir, args.values.debug);
    if (written) err(debugWrittenLine(written, dir));
    const submissions = result.skipped.filter((s) => !s.orphan).length;
    const orphans = result.skipped.length - submissions;
    err(
        `graded ${result.rows.length}, skipped ${submissions} submission(s)${orphans ? ` and ${orphans} group(s) of orphan pages` : ""} from ${basename(zipPath)}\n`,
    );
    return result.skipped.length ? 2 : 0;
}
