// Orchestrates a grading run: zip → pages → submissions → OCR + key → free-response
// transcription and grading → (review) → scores.
// IO-free (apart from the injected callbacks) so the whole flow is testable.
import { scoreAnswers } from "./grade.ts";
import { groupPages, type Group } from "./grouping.ts";
import { crop, encodePng, pageToCanvas } from "./image.ts";
import type { FreeKey, GradingKey } from "./key.ts";
import { answerRingRadius, colX, LAYOUT, ringCol, ringRadius, rowY } from "./layout.ts";
import { limitConcurrency, type NameReader, type ResponseGrader } from "./ocr.ts";
import { DEFAULT_THRESHOLDS, processPage, type PageResult, type QuestionRead, type Thresholds } from "./pipeline.ts";
import { decodedLine } from "./report.ts";
import { SKIPPED_IN_REVIEW, type AnswerItem, type ReviewDecision, type ReviewItem } from "./review.ts";
import { readZipImages } from "./zip.ts";

export class FatalError extends Error {
    override name = "FatalError";
}

export interface RunOptions {
    nameReader: NameReader;
    /** Transcribes and grades free-response answers; required when the sheets have any. */
    responseGrader?: ResponseGrader;
    /**
     * Called once, after decoding, with the largest ring count per question and which questions
     * are free response (have a writing box).
     */
    getKey: (maxChoices: number[], free: boolean[]) => Promise<GradingKey>;
    thresholds?: Thresholds;
    ocrConcurrency?: number;
    onProgress?: (msg: string) => void;
    /**
     * Turns on review: unclear marks, names and free-response answers are asked about instead of
     * skipping the submission, and every name and free-response grade is confirmed. `begin` gets
     * every item with its crop, then `ask` is called per item in order, except for the remaining
     * items of a submission skipped in review.
     */
    review?: {
        begin(items: { item: ReviewItem; png: Uint8Array }[]): Promise<void>;
        ask(item: ReviewItem, total: number): Promise<ReviewDecision>;
    };
}

/** A graded free-response answer. */
export interface GradedResponse {
    /** 0-based question index. */
    index: number;
    points: number;
    /** The transcript. */
    text: string;
    /** The grading model's reason, or a note that the teacher set the points in review. */
    feedback: string;
}

export interface GradedRow {
    name: string;
    score: number;
    total: number;
    percent: string;
    files: string[];
    /** Its free-response answers, in question order. */
    responses: GradedResponse[];
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
    /** 0-based indexes of the free-response questions. */
    free: number[];
}

/** One free-response answer, transcribed and (when that worked) graded. */
interface ResponseRead {
    index: number;
    file: string;
    png: Uint8Array;
    text: string | null;
    legible: boolean;
    points: number | null;
    feedback: string;
    error?: string;
}

/** The feedback recorded for a blank box, which scores 0 without asking the grading model. */
export const BLANK_FEEDBACK = "No answer written.";
export const REVIEWED_FEEDBACK = "Points set in review.";

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

    // Which questions have a writing box, from every page whose QR was read.
    const free = new Array<boolean>(totalQuestions).fill(false);
    for (const p of pages) p.payload?.boxes?.forEach((b, i) => b && (free[p.payload!.firstQuestionIndex + i] = true));
    const freeIndexes = free.flatMap((f, i) => (f ? [i] : []));
    if (freeIndexes.length && !o.responseGrader) throw new FatalError("the sheets have free-response questions, but no grader for them was given");

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
    const key = await o.getKey(
        maxChoices.map((n, i) => (free[i] ? 0 : n || LAYOUT.ring.maxChoices)),
        free,
    );

    // Free-response answers need the key (their prompts and model answers), so they start now.
    const responses = new Map<Group<PageResult>, Promise<ResponseRead[]>>();
    if (freeIndexes.length) {
        const grade = limitConcurrency(o.ocrConcurrency ?? 4, (p: PageResult, r: { index: number; png: Uint8Array }) =>
            readResponse(o.responseGrader!, key[r.index] as FreeKey, p.file, r, !!o.review),
        );
        for (const g of valid) responses.set(g, Promise.all(g.pages.flatMap((p) => (p.responses ?? []).map((r) => grade(p, r)))));
    }

    const decisions = o.review ? await reviewSubmissions(valid, names, responses, key, o.review) : undefined;

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
        const reads = (await responses.get(r)) ?? [];
        // Without review, an answer that couldn't be read or graded skips the submission.
        const unsettled = reads.filter((x) => x.points === null && d?.points.get(x.index) === undefined);
        if (!name || unsettled.length) {
            const reasons = [
                ...(name ? [] : [`${files[0]}: ${ocr.error}`]),
                ...unsettled.map((x) => `${x.file}: Q${x.index + 1}: ${x.error ?? "answer is partly illegible"}`),
            ];
            skipped.push({ files, reasons, orphan: false });
            continue;
        }
        const answers: (number[] | number)[] = new Array(totalQuestions).fill(null).map(() => []);
        for (const p of g.pages) for (const q of p.questions ?? []) answers[q.index] = d?.answers.get(q.index) ?? q.marked;
        const graded: GradedResponse[] = reads
            .map((x) => {
                const set = d?.points.get(x.index);
                const changed = set !== undefined && set !== x.points;
                return { index: x.index, points: set ?? x.points!, text: x.text ?? "", feedback: changed ? REVIEWED_FEEDBACK : x.feedback };
            })
            .sort((a, b) => a.index - b.index);
        for (const x of graded) answers[x.index] = x.points;
        rows.push({ name, files, ...scoreAnswers(answers, key), responses: graded });
    }
    const skippedFiles = new Set(skipped.flatMap((s) => s.files));
    return { rows, skipped, pages, problemPages: pages.filter((p) => skippedFiles.has(p.file) || p.reasons.length), free: freeIndexes };
}

/**
 * Transcribes one answer box, then grades it. A blank box scores 0 without a grading call. A
 * partly illegible one is graded on its best reading only under review, where the teacher sees it.
 */
async function readResponse(grader: ResponseGrader, key: FreeKey, file: string, r: { index: number; png: Uint8Array }, review: boolean): Promise<ResponseRead> {
    const base = { index: r.index, file, png: r.png, points: null, feedback: "" };
    let text;
    try {
        text = await grader.readResponse(r.png, file, r.index, key.prompt);
    } catch (e) {
        return { ...base, text: null, legible: false, error: `OCR failed: ${(e as Error).message}` };
    }
    if (!text.text) return { ...base, ...text, points: 0, feedback: BLANK_FEEDBACK };
    if (!text.legible && !review) return { ...base, ...text, error: "answer is partly illegible" };
    try {
        const g = await grader.gradeResponse(key, text.text, r.index);
        return { ...base, ...text, points: Math.max(0, Math.min(key.points, Math.round(g.points))), feedback: g.feedback };
    } catch (e) {
        return { ...base, ...text, error: `grading failed: ${(e as Error).message}` };
    }
}

type Decisions = Map<Group<PageResult>, "skip" | { name?: string; answers: Map<number, number[]>; points: Map<number, number> }>;

/**
 * Builds the review items (each submission's name, then its unclear questions and free-response
 * answers in question order) and asks them.
 */
async function reviewSubmissions(
    valid: Group<PageResult>[],
    names: Map<Group<PageResult>, Promise<{ name?: string; error?: string }>>,
    responses: Map<Group<PageResult>, Promise<ResponseRead[]>>,
    key: GradingKey,
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
        // Unclear questions and free-response answers, in question order.
        const pending: ({ index: number; answer: { p: PageResult; q: QuestionRead } } | { index: number; response: ResponseRead })[] = [];
        for (const p of g.pages) {
            for (const q of p.questions ?? []) if (q.rings.some((r) => r.verdict === "ambiguous")) pending.push({ index: q.index, answer: { p, q } });
        }
        for (const r of (await responses.get(g)) ?? []) pending.push({ index: r.index, response: r });
        pending.sort((a, b) => a.index - b.index);
        for (const it of pending) {
            const id = items.length + 1;
            if ("response" in it) {
                const r = it.response;
                items.push({
                    item: {
                        kind: "response",
                        id,
                        submission,
                        image: `r-${id}.png`,
                        file: r.file,
                        question: r.index + 1,
                        maxPoints: key[r.index]!.points,
                        text: r.text,
                        legible: r.legible,
                        points: r.points,
                        feedback: r.feedback,
                        ...(r.error ? { error: r.error } : {}),
                    },
                    png: r.png,
                    group: g,
                    index: r.index,
                });
                continue;
            }
            const { p, q } = it.answer;
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
        if (!d) decisions.set(group, (d = { answers: new Map(), points: new Map() }));
        if ("name" in answer) d.name = answer.name;
        else if ("points" in answer) d.points.set(index!, answer.points);
        else d.answers.set(index!, answer.answer);
    }
    return decisions;
}

/**
 * A question's part of the rectified page (its choices and the line above, or on an answer sheet
 * its row from the number to the last bubble and half the rows around it) and where its bubbles are.
 */
async function questionCrop(p: PageResult, q: QuestionRead): Promise<Pick<AnswerItem, "width" | "height" | "rings"> & { png: Uint8Array }> {
    const { canvas, rectified } = p.registration!;
    const L = LAYOUT;
    const ys = q.rings.map((r) => r.center.y);
    const cell = L.cellH * canvas.scale;
    const round = (n: number) => Math.round(n * 10) / 10;
    if (p.payload?.answerGrid) {
        const s = canvas.scale;
        const rr = answerRingRadius(L) * s;
        const xs = q.rings.map((r) => r.center.x);
        const x0 = Math.max(0, Math.floor(Math.min(...xs) - rr - (L.answer.numberW + L.answer.numberGap + 6) * s));
        const x1 = Math.min(rectified.width, Math.ceil(Math.max(...xs) + rr + 12 * s));
        const y0 = Math.max(0, Math.floor(Math.min(...ys) - 1.1 * cell));
        const y1 = Math.min(rectified.height, Math.ceil(Math.max(...ys) + 1.1 * cell));
        const img = crop(rectified, x0, y0, x1 - x0, y1 - y0);
        const r = round(rr);
        return {
            png: await encodePng(img),
            width: img.width,
            height: img.height,
            rings: q.rings.map((ring) => ({ x: round(ring.center.x - x0), y: round(ring.center.y - y0), r })),
        };
    }
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
    const r = round(ringRadius(L) * canvas.scale);
    return {
        png: await encodePng(img),
        width: img.width,
        height: img.height,
        rings: q.rings.map((ring) => ({ x: round(ring.center.x - x0), y: round(ring.center.y - y0), r })),
    };
}
