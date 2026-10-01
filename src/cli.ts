// CLI: bun run grade.ts <sheets.zip> [--debug] [--mark <ratio>] [--blank <ratio>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { CSV_HEADER, csvRow } from "./csv.ts";
import { renderDebug } from "./debug.ts";
import { KeyAbortError, promptKey } from "./key.ts";
import { OpenRouterNameReader, type NameReader } from "./ocr.ts";
import { DEFAULT_THRESHOLDS } from "./pipeline.ts";
import { FatalError, gradeZip, type RunResult } from "./run.ts";
import { ZipError } from "./zip.ts";

const USAGE = "usage: bun run grade.ts <sheets.zip> [--debug] [--mark <ratio>] [--blank <ratio>]";

function timestampDir(zipPath: string): string {
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    return join(dirname(zipPath), `grade-${ts}`);
}

async function writeDebugImages(result: RunResult, dir: string, all: boolean): Promise<number> {
    const pages = all ? result.pages : result.problemPages;
    if (!pages.length) return 0;
    mkdirSync(dir, { recursive: true });
    for (const p of pages) {
        const name = p.file.replace(/[\\/:*?"<>|]/g, "_").replace(/\.[^.]+$/, "");
        writeFileSync(join(dir, `${name}.png`), await renderDebug(p));
    }
    return pages.length;
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

    let result: RunResult;
    try {
        result = await gradeZip(zip, {
            nameReader,
            thresholds,
            getKey: (maxChoices) => promptKey(maxChoices, deps.stdin, err),
            onProgress: (m) => err(`${m}\n`),
        });
    } catch (e) {
        if (e instanceof FatalError || e instanceof ZipError || e instanceof KeyAbortError) {
            err(`fatal: ${e.message}\n`);
            return 1;
        }
        throw e;
    }

    out(csvRow(CSV_HEADER));
    for (const r of result.rows) out(csvRow([r.name, r.score, r.total, r.percent]));

    for (const s of result.skipped) {
        err(`skipped ${s.orphan ? "orphan pages" : "submission"} [${s.files.join(", ")}]:\n`);
        for (const r of s.reasons) err(`  - ${r}\n`);
    }
    const dir = timestampDir(zipPath);
    const written = await writeDebugImages(result, dir, args.values.debug);
    if (written) err(`wrote ${written} diagnostic image(s) to ${dir}\n`);
    const submissions = result.skipped.filter((s) => !s.orphan).length;
    const orphans = result.skipped.length - submissions;
    err(
        `graded ${result.rows.length}, skipped ${submissions} submission(s)${orphans ? ` and ${orphans} group(s) of orphan pages` : ""} from ${basename(zipPath)}\n`,
    );
    return result.skipped.length ? 2 : 0;
}
