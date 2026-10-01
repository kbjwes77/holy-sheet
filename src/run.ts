// Orchestrates a grading run: zip → pages → submissions → OCR + key → scores.
// IO-free (apart from the injected callbacks) so the whole flow is testable.
import { scoreAnswers } from "./grade.ts";
import { groupPages, type Group } from "./grouping.ts";
import type { Key } from "./key.ts";
import { LAYOUT } from "./layout.ts";
import { limitConcurrency, type NameReader } from "./ocr.ts";
import { DEFAULT_THRESHOLDS, processPage, type PageResult, type Thresholds } from "./pipeline.ts";
import { readZipImages } from "./zip.ts";

export class FatalError extends Error {
    override name = "FatalError";
}

export interface RunOptions {
    nameReader: NameReader;
    /** Called once, after decoding, with the largest ring count per question. */
    getKey: (maxChoices: number[]) => Promise<Key>;
    thresholds?: Thresholds;
    ocrConcurrency?: number;
    onProgress?: (msg: string) => void;
}

export interface GradedRow {
    name: string;
    score: number;
    total: number;
    percent: string;
    files: string[];
}

export interface SkippedSubmission {
    files: string[];
    reasons: string[];
    orphan: boolean;
}

export interface RunResult {
    rows: GradedRow[];
    skipped: SkippedSubmission[];
    pages: PageResult[];
    /** Pages belonging to skipped submissions. */
    problemPages: PageResult[];
}

export async function gradeZip(zip: Uint8Array, o: RunOptions): Promise<RunResult> {
    const images = readZipImages(zip);
    if (!images.length) throw new FatalError("the zip contains no JPEG or PNG images");

    const pages: PageResult[] = [];
    for (const [i, img] of images.entries()) {
        pages.push(await processPage(img.name, img.bytes, o.thresholds ?? DEFAULT_THRESHOLDS));
        o.onProgress?.(`decoded ${i + 1}/${images.length}: ${img.name}${pages.at(-1)!.reasons.length ? " (problem)" : ""}`);
    }

    const totals = new Set(pages.flatMap((p) => (p.payload ? [p.payload.totalQuestions] : [])));
    if (totals.size > 1) throw new FatalError(`the zip mixes tests: pages report ${[...totals].join(", ")} total questions`);
    const totalQuestions = [...totals][0];
    if (totalQuestions === undefined) throw new FatalError("no page had a readable QR code");

    const groups = groupPages(pages);
    const valid = groups.filter((g) => !g.reasons.length);

    // OCR runs while the key prompt waits.
    const read = limitConcurrency(o.ocrConcurrency ?? 4, (png: Uint8Array, file: string) => o.nameReader.readName(png, file));
    const names = new Map<Group<PageResult>, Promise<{ name?: string; error?: string }>>(
        valid.map((g) => {
            const first = g.pages[0]!;
            const p = first.nameCrop
                ? read(first.nameCrop, first.file).then(
                      (name) => (name ? { name } : { error: "name is empty or illegible" }),
                      (e: Error) => ({ error: `OCR failed: ${e.message}` }),
                  )
                : Promise.resolve({ error: "no name crop" });
            return [g, p] as const;
        }),
    );

    const maxChoices = new Array<number>(totalQuestions).fill(0);
    for (const g of valid) for (const p of g.pages) for (const q of p.questions ?? []) maxChoices[q.index] = Math.max(maxChoices[q.index]!, q.choices);
    // Questions never read (every submission skipped) fall back to the layout maximum.
    const key = await o.getKey(maxChoices.map((n) => n || LAYOUT.ring.maxChoices));

    const rows: GradedRow[] = [];
    const skipped: SkippedSubmission[] = [];
    for (const g of groups) {
        const files = g.pages.map((p) => p.file);
        if (g.reasons.length) {
            skipped.push({ files, reasons: g.reasons, orphan: g.orphan });
            continue;
        }
        const ocr = await names.get(g)!;
        if (!ocr.name) {
            skipped.push({ files, reasons: [`${files[0]}: ${ocr.error}`], orphan: false });
            continue;
        }
        const marked: number[][] = new Array(totalQuestions).fill(null).map(() => []);
        for (const p of g.pages) for (const q of p.questions ?? []) marked[q.index] = q.marked;
        rows.push({ name: ocr.name, files, ...scoreAnswers(marked, key) });
    }
    const skippedFiles = new Set(skipped.flatMap((s) => s.files));
    return { rows, skipped, pages, problemPages: pages.filter((p) => skippedFiles.has(p.file) || p.reasons.length) };
}
