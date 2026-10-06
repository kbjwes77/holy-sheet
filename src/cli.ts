// CLI: bun run grade.ts <sheets.zip> [--test <test.json>] [--debug] [--review] [--mark <ratio>] [--blank <ratio>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { parseSheetJson } from "../gen/testdef.ts";
import { csvHeader, csvRow, gradedRowFields } from "./csv.ts";
import { renderDebug } from "./debug.ts";
import { ask, checkKey, choiceKey, KeyAbortError, LineReader, promptKey, type GradingKey } from "./key.ts";
import { OpenRouterReader, type NameReader, type ResponseGrader } from "./ocr.ts";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./pipeline.ts";
import { debugImageName, debugWrittenLine, skippedHeader, skippedReasonLine } from "./report.ts";
import { parseReviewReply, REVIEW_FILE, reviewPrompt, reviewStartLine, type ReviewDecision, type ReviewFile } from "./review.ts";
import { FatalError, gradeZip, type RunOptions, type RunResult } from "./run.ts";
import { ZipError } from "./zip.ts";

const USAGE = "usage: bun run grade.ts <sheets.zip> [--test <test.json>] [--debug] [--review] [--mark <ratio>] [--blank <ratio>]";

/** The grading key in a test's JSON, or why it can't be graded from it. */
export function loadTestKey(path: string): { key: GradingKey } | { error: string } {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (e) {
        return { error: `cannot read ${path}: ${(e as Error).message}` };
    }
    // The sheets were printed already; the layout needn't be checked again.
    const parsed = parseSheetJson(text, { layout: false });
    if (!parsed.ok) {
        const shown = parsed.errors.slice(0, 5).map((e) => `${e.where}: ${e.message}`);
        const more = parsed.errors.length > 5 ? `; and ${parsed.errors.length - 5} more` : "";
        return { error: `${basename(path)} is not a valid test: ${shown.join("; ")}${more}` };
    }
    if (!parsed.grading) return { error: `${basename(path)} has no answers; give every question an "answer" to grade with it` };
    return { key: parsed.grading };
}

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
    /** Override the OpenRouter calls (tests). */
    nameReader?: NameReader;
    responseGrader?: ResponseGrader;
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
                test: { type: "string" },
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

    let testKey: GradingKey | undefined;
    if (args.values.test !== undefined) {
        const loaded = loadTestKey(args.values.test);
        if ("error" in loaded) {
            err(`fatal: ${loaded.error}\n`);
            return 1;
        }
        testKey = loaded.key;
    }

    let nameReader = deps.nameReader;
    let responseGrader = deps.responseGrader;
    if (!nameReader || !responseGrader) {
        const apiKey = env.OPENROUTER_API_KEY;
        const model = env.OPENROUTER_MODEL;
        const missing = [!apiKey && "OPENROUTER_API_KEY", !model && "OPENROUTER_MODEL"].filter(Boolean);
        if (missing.length && !nameReader) {
            err(`fatal: ${missing.join(" and ")} must be set (e.g. in .env)\n`);
            return 1;
        }
        // Tests may mock only names; free-response calls then go to OpenRouter only when it's set up.
        const reader = missing.length ? undefined : new OpenRouterReader({ apiKey: apiKey!, model: model! });
        nameReader ??= reader!;
        responseGrader ??= reader;
    }

    const getKey = async (maxChoices: number[], free: boolean[]): Promise<GradingKey> => {
        if (testKey) {
            const problem = checkKey(testKey, maxChoices, free);
            if (problem) throw new FatalError(`${basename(args.values.test!)} doesn't match the sheets: ${problem}`);
            return testKey;
        }
        if (free.some(Boolean)) throw new FatalError("the sheets have free-response questions; grade them with --test <test.json>, the test's JSON with every answer");
        return choiceKey(await promptKey(maxChoices, lines, err));
    };

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
            ...(responseGrader ? { responseGrader } : {}),
            thresholds,
            getKey,
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

    out(csvRow(csvHeader(result.free)));
    for (const r of result.rows) out(csvRow(gradedRowFields(r, result.free)));

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
