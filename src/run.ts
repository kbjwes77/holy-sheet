// Orchestrates a grading run: zip → pages → submissions → OCR + key → (review) → scores.
// IO-free (apart from the injected callbacks) so the whole flow is testable.
import { scoreAnswers } from "./grade.ts";
import { groupPages, type Group } from "./grouping.ts";
import { crop, encodePng, pageToCanvas } from "./image.ts";
import type { Key } from "./key.ts";
import { colX, LAYOUT, ringCol, ringRadius, rowY } from "./layout.ts";
import { limitConcurrency, type NameReader } from "./ocr.ts";
import { DEFAULT_THRESHOLDS, processPage, type PageResult, type QuestionRead, type Thresholds } from "./pipeline.ts";
import { decodedLine } from "./report.ts";
import { SKIPPED_IN_REVIEW, type AnswerItem, type ReviewDecision, type ReviewItem } from "./review.ts";
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
    /**
     * Turns on review: unclear marks and names are asked about instead of skipping the submission,
     * and every name is confirmed. `begin` gets every item with its crop, then `ask` is called per
     * item in order, except for the remaining items of a submission skipped in review.
     */
    review?: {
        begin(items: { item: ReviewItem; png: Uint8Array }[]): Promise<void>;
        ask(item: ReviewItem, total: number): Promise<ReviewDecision>;
    };
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
        o.onProgress?.(decodedLine(i + 1, images.length, img.name, pages.at(-1)!.reasons.length > 0));
    }

    const totals = new Set(pages.flatMap((p) => (p.payload ? [p.payload.totalQuestions] : [])));
    if (totals.size > 1) throw new FatalError(`the zip mixes tests: pages report ${[...totals].join(", ")} total questions`);
    const totalQuestions = [...totals][0];
    if (totalQuestions === undefined) throw new FatalError("no page had a readable QR code");

    const groups = groupPages(pages);
    // Under review a page whose only problems are unclear marks still counts; the review asks
    // about them. Grouping depends only on payloads, so both groupings line up.
    const reviewable = o.review
        ? groupPages(pages.map((p) => (p.ambiguous?.length === p.reasons.length ? { ...p, reasons: [] } : p))).map((g, i) => ({ ...g, pages: groups[i]!.pages }))
        : groups;
    const valid = reviewable.filter((g) => !g.reasons.length);

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

    const decisions = o.review ? await reviewSubmissions(valid, names, o.review) : undefined;

    const rows: GradedRow[] = [];
    const skipped: SkippedSubmission[] = [];
    for (const [i, g] of groups.entries()) {
        const files = g.pages.map((p) => p.file);
        const r = reviewable[i]!;
        if (r.reasons.length) {
            skipped.push({ files, reasons: g.reasons, orphan: g.orphan });
            continue;
        }
        const d = decisions?.get(r);
        if (d === "skip") {
            skipped.push({ files, reasons: [SKIPPED_IN_REVIEW], orphan: false });
            continue;
        }
        const ocr = await names.get(r)!;
        const name = d?.name || ocr.name;
        if (!name) {
            skipped.push({ files, reasons: [`${files[0]}: ${ocr.error}`], orphan: false });
            continue;
        }
        const marked: number[][] = new Array(totalQuestions).fill(null).map(() => []);
        for (const p of g.pages) for (const q of p.questions ?? []) marked[q.index] = d?.answers.get(q.index) ?? q.marked;
        rows.push({ name, files, ...scoreAnswers(marked, key) });
    }
    const skippedFiles = new Set(skipped.flatMap((s) => s.files));
    return { rows, skipped, pages, problemPages: pages.filter((p) => skippedFiles.has(p.file) || p.reasons.length) };
}

type Decisions = Map<Group<PageResult>, "skip" | { name?: string; answers: Map<number, number[]> }>;

/** Builds the review items (each submission's name, then its unclear questions) and asks them. */
async function reviewSubmissions(
    valid: Group<PageResult>[],
    names: Map<Group<PageResult>, Promise<{ name?: string; error?: string }>>,
    review: NonNullable<RunOptions["review"]>,
): Promise<Decisions> {
    const items: { item: ReviewItem; png: Uint8Array; group: Group<PageResult>; index?: number }[] = [];
    for (const [submission, g] of valid.entries()) {
        const ocr = await names.get(g)!;
        const id = items.length + 1;
        items.push({
            item: {
                kind: "name",
                id,
                submission,
                image: `name-${id}.png`,
                files: g.pages.map((p) => p.file),
                ocr: ocr.name ?? null,
                ...(ocr.error ? { error: ocr.error } : {}),
            },
            png: g.pages[0]!.nameCrop ?? new Uint8Array(),
            group: g,
        });
        for (const p of g.pages) {
            for (const q of p.questions ?? []) {
                if (!q.rings.some((r) => r.verdict === "ambiguous")) continue;
                const id = items.length + 1;
                const { png, ...view } = await questionCrop(p, q);
                items.push({
                    item: {
                        kind: "answer",
                        id,
                        submission,
                        image: `q-${id}.png`,
                        file: p.file,
                        question: q.index + 1,
                        choices: q.choices,
                        marked: q.marked,
                        unclear: q.rings.flatMap((r, j) => (r.verdict === "ambiguous" ? [j] : [])),
                        fills: q.rings.map((r) => Math.round(r.fill * 100) / 100),
                        verdicts: q.rings.map((r) => r.verdict),
                        ...view,
                    },
                    png,
                    group: g,
                    index: q.index,
                });
            }
        }
    }

    const decisions: Decisions = new Map();
    if (!items.length) return decisions;
    await review.begin(items.map(({ item, png }) => ({ item, png })));
    for (const { item, group, index } of items) {
        let d = decisions.get(group);
        if (d === "skip") continue;
        const answer = await review.ask(item, items.length);
        if ("skip" in answer) {
            decisions.set(group, "skip");
            continue;
        }
        if (!d) decisions.set(group, (d = { answers: new Map() }));
        if ("name" in answer) d.name = answer.name;
        else d.answers.set(index!, answer.answer);
    }
    return decisions;
}

/** A question's part of the rectified page (its choices and the line above) and where its bubbles are. */
async function questionCrop(p: PageResult, q: QuestionRead): Promise<Pick<AnswerItem, "width" | "height" | "rings"> & { png: Uint8Array }> {
    const { canvas, rectified } = p.registration!;
    const L = LAYOUT;
    const ys = q.rings.map((r) => r.center.y);
    const cell = L.cellH * canvas.scale;
    // The bubbles and the start of each choice's text: narrow enough to show the bubbles large.
    // A left-column (or full-width) question starts after the marker column; a right-column one
    // two columns before its bubbles, clear of the divider.
    const bubbles = ringCol(q.column, L);
    const x0 = Math.max(0, Math.floor(pageToCanvas(canvas, { x: colX(q.column ? bubbles - 2 : L.marker.col + 1, L), y: 0 }).x));
    const x1 = Math.ceil(pageToCanvas(canvas, { x: colX(Math.min(bubbles + 18, L.cols - 1), L), y: 0 }).x);
    // Below the top corner squares, which a question starting on row 4 would otherwise clip.
    const top = pageToCanvas(canvas, { x: 0, y: rowY(L.cornerSquares[0].row2 + 1, L) }).y;
    const y0 = Math.max(0, Math.floor(Math.max(top, Math.min(...ys) - 1.6 * cell)));
    const y1 = Math.ceil(Math.max(...ys) + 0.6 * cell);
    const img = crop(rectified, x0, y0, x1 - x0, y1 - y0);
    const round = (n: number) => Math.round(n * 10) / 10;
    const r = round(ringRadius(L) * canvas.scale);
    return {
        png: await encodePng(img),
        width: img.width,
        height: img.height,
        rings: q.rings.map((ring) => ({ x: round(ring.center.x - x0), y: round(ring.center.y - y0), r })),
    };
}
