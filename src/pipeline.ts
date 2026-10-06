// Per-image pipeline: load → QR → register → markers → bubbles → fill → name and answer-box crops.
import { PayloadError, answerBlock, unpack, type PagePayload } from "./codec.ts";
import { crop, encodePng, loadGray, pageToCanvas, type Gray } from "./image.ts";
import { LAYOUT, type BubbleColumn, type LayoutSpec, type Point, type Rect, answerBubbleCenter, answerRingRadius, bubbleCenter, rangeRect, responseBoxRect } from "./layout.ts";
import { fillAt, findBubble, inkReference, ringKernels } from "./marks.ts";
import { decodeQr } from "./qr.ts";
import { register, type Registration } from "./registration.ts";

export interface Thresholds {
    /** Fill above this (relative to printed ink) is a mark. */
    markThreshold: number;
    /** Fill below this is blank; in between is ambiguous. */
    blankThreshold: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { markThreshold: 0.45, blankThreshold: 0.15 };

export type Verdict = "marked" | "blank" | "ambiguous";

export interface QuestionRead {
    /** 0-based question index across the test. */
    index: number;
    /** Grid row of the question's first (A) bubble. */
    row: number;
    /** The bubble column its bubbles are in (0 on an answer sheet). */
    column: BubbleColumn;
    choices: number;
    /** Marked choice indexes. */
    marked: number[];
    rings: { center: Point; fill: number; verdict: Verdict }[];
}

export interface PageResult {
    file: string;
    reasons: string[];
    payload?: PagePayload;
    questions?: QuestionRead[];
    /** PNG of the Name box (page 1 only). */
    nameCrop?: Uint8Array;
    /** PNG of each free-response box on the page, by 0-based question index across the test. */
    responses?: { index: number; png: Uint8Array }[];
    /** For diagnostic images. */
    source?: Gray;
    registration?: Registration;
    /** Row-level problems to draw (canvas px). */
    rowErrors?: { y: number; text: string }[];
    /** The entries of `reasons` that are only unclear marks, which `--review` asks about. */
    ambiguous?: string[];
}

/**
 * The fill an unmarked ring reads on this page. Blur and low resolution bleed the ring outline
 * into the measured disk, by an amount that varies per capture. Most rings
 * on a page are blank, so the lower quartile estimates it (the minimum, when there are only a
 * few rings). It is capped so a page of mostly marked rings can't push real marks below threshold.
 */
export function blankBaseline(fills: number[]): number {
    if (!fills.length) return 0;
    const sorted = [...fills].sort((a, b) => a - b);
    if (fills.length < 6) return Math.min(0.2, sorted[0]!);
    return Math.min(0.25, sorted[Math.floor(sorted.length / 4)]!);
}

export async function processPage(
    file: string,
    bytes: Uint8Array,
    th: Thresholds = DEFAULT_THRESHOLDS,
    L: LayoutSpec = LAYOUT,
): Promise<PageResult> {
    const res: PageResult = { file, reasons: [] };
    let img: Gray;
    try {
        img = await loadGray(bytes);
    } catch (e) {
        res.reasons.push(`image could not be read: ${(e as Error).message}`);
        return res;
    }
    res.source = img;

    const hit = await decodeQr(img);
    if (!hit) {
        res.reasons.push("QR code not found");
        return res;
    }
    try {
        res.payload = unpack(hit.bytes);
    } catch (e) {
        if (!(e instanceof PayloadError)) throw e;
        res.reasons.push(`invalid QR payload: ${e.message}`);
        return res;
    }
    const payload = res.payload;

    let reg: Registration;
    try {
        reg = register({ img, qrCorners: hit.corners, layout: L });
    } catch (e) {
        res.reasons.push(`page registration failed: ${(e as Error).message}`);
        return res;
    }
    res.registration = reg;
    const { canvas, dark } = reg;

    // Markers must match the QR's bubble rows exactly. A row with bubbles in both columns has one marker.
    const found = reg.markers.markers.map((m) => m.row);
    const expected = [...new Set(payload.choiceRows.flat())].sort((a, b) => a - b);
    const sameRows = found.length === expected.length && expected.every((r, i) => r === found[i]);
    if (!sameRows || reg.markers.misaligned.length) {
        const missing = expected.filter((r) => !found.includes(r));
        const extra = found.filter((r) => !expected.includes(r));
        const parts = [`marker rows don't match the QR (expected ${expected.length}, found ${found.length}`];
        if (missing.length) parts.push(`missing rows ${missing.join(" ")}`);
        if (extra.length) parts.push(`unexpected rows ${extra.join(" ")}`);
        if (reg.markers.misaligned.length) parts.push(`${reg.markers.misaligned.length} off-grid marker(s)`);
        const corners = reg.cornersFound;
        if (corners < 4) parts.push(`only ${corners}/4 corner squares found during registration; is the page cut off?`);
        res.reasons.push(parts.join("; ") + ")");
        return res;
    }

    // An answer sheet's bubbles sit side by side on the question's row, and are bigger.
    const grid = payload.answerGrid;
    const k = ringKernels(canvas, L, grid ? answerRingRadius(L) : undefined);
    const expectedAt = (i: number, j: number, row: number) =>
        grid ? answerBubbleCenter(answerBlock(payload, i), j, row, grid.slots, L) : bubbleCenter(row, payload.columns[i]!, L);
    const ink = Math.max(0.3, inkReference(dark, reg.markers.markers, canvas, L));
    const byRow = new Map(reg.markers.markers.map((m) => [m.row, m]));
    res.rowErrors = [];
    const qs = payload.choiceRows.map((rows, i) => {
        const hits = rows.map((row, j) => {
            const marker = byRow.get(row)!;
            const hit = findBubble(dark, canvas, row, expectedAt(i, j, row), marker.center.y, k, L);
            if (hit.error) {
                res.reasons.push(`Q${payload.firstQuestionIndex + i + 1} ${String.fromCharCode(65 + j)}: ${hit.error}`);
                res.rowErrors!.push({ y: marker.center.y, text: hit.error });
            }
            return { center: hit.center, error: hit.error, raw: fillAt(dark, k, hit.center) / ink };
        });
        return { rows, i, hits };
    });
    const base = blankBaseline(qs.flatMap((q) => q.hits.filter((h) => !h.error).map((h) => h.raw)));

    res.questions = [];
    qs.forEach(({ rows, i, hits }) => {
        if (payload.boxes?.[i]) return;
        const rings = hits.map(({ center, raw }) => {
            const fill = Math.max(0, (raw - base) / (1 - base));
            const verdict: Verdict = fill > th.markThreshold ? "marked" : fill < th.blankThreshold ? "blank" : "ambiguous";
            return { center, fill, verdict };
        });
        const ambiguous = rings.flatMap((r, j) => (r.verdict === "ambiguous" && !hits[j]!.error ? [String.fromCharCode(65 + j)] : []));
        if (ambiguous.length) {
            const reason = `Q${payload.firstQuestionIndex + i + 1}: ambiguous mark on ${ambiguous.join(", ")} (fill ${rings
                .filter((r, j) => r.verdict === "ambiguous" && !hits[j]!.error)
                .map((r) => r.fill.toFixed(2))
                .join(", ")})`;
            res.reasons.push(reason);
            (res.ambiguous ??= []).push(reason);
        }
        res.questions!.push({
            index: payload.firstQuestionIndex + i,
            row: rows[0]!,
            column: payload.columns[i]!,
            choices: rings.length,
            marked: rings.flatMap((r, j) => (r.verdict === "marked" ? [j] : [])),
            rings,
        });
    });

    const cropRect = async (r: Rect, padX: number, padY = padX) => {
        const a = pageToCanvas(canvas, { x: r.x - padX, y: r.y - padY });
        const b = pageToCanvas(canvas, { x: r.x + r.w + padX, y: r.y + r.h + padY });
        return encodePng(crop(reg.rectified, a.x, a.y, b.x - a.x, b.y - a.y));
    };
    if (payload.pageNumber === 1) res.nameCrop = await cropRect(rangeRect(L.fields.name, L), 6);
    // Little room above a box: its question's prompt can end on the row just above it.
    for (const [i, box] of (payload.boxes ?? []).entries()) {
        if (box) (res.responses ??= []).push({ index: payload.firstQuestionIndex + i, png: await cropRect(responseBoxRect(box.row, box.rows, L), 5, 2) });
    }
    return res;
}
