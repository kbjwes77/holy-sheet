// Per-image pipeline: load → QR → register → markers → rings → fill → name crop.
import { PayloadError, unpack, type PagePayload } from "./codec.ts";
import { crop, encodePng, loadGray, pageToCanvas, type Gray } from "./image.ts";
import { LAYOUT, type LayoutSpec, type Point, rangeRect } from "./layout.ts";
import { fillAt, findRings, inkReference, ringKernels } from "./marks.ts";
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
    row: number;
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
    /** For diagnostic images. */
    source?: Gray;
    registration?: Registration;
    /** Row-level problems to draw (canvas px). */
    rowErrors?: { y: number; text: string }[];
}

/**
 * The fill an unmarked ring reads on this page. Blur and low resolution bleed the ring outline
 * and its printed letter into the measured disk, by an amount that varies per capture. Most rings
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

    // Markers must match the QR row list exactly.
    const found = reg.markers.markers.map((m) => m.row);
    const expected = payload.rows;
    const sameRows = found.length === expected.length && [...expected].sort((a, b) => a - b).every((r, i) => r === found[i]);
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

    const k = ringKernels(canvas, L);
    const ink = Math.max(0.3, inkReference(dark, reg.markers.markers, canvas, L));
    const byRow = new Map(reg.markers.markers.map((m) => [m.row, m]));
    res.rowErrors = [];
    const rows = payload.rows.map((row, i) => {
        const marker = byRow.get(row)!;
        const ringRow = findRings(dark, canvas, row, marker.center.y, k, L);
        if (ringRow.error) {
            res.reasons.push(`Q${payload.firstQuestionIndex + i + 1}: ${ringRow.error}`);
            res.rowErrors!.push({ y: marker.center.y, text: ringRow.error });
        }
        return { row, i, ringRow, raw: ringRow.centers.map((center) => fillAt(dark, k, center) / ink) };
    });
    const base = blankBaseline(rows.flatMap((r) => r.raw));

    res.questions = [];
    rows.forEach(({ row, i, ringRow, raw }) => {
        const rings = ringRow.centers.map((center, j) => {
            const fill = Math.max(0, (raw[j]! - base) / (1 - base));
            const verdict: Verdict = fill > th.markThreshold ? "marked" : fill < th.blankThreshold ? "blank" : "ambiguous";
            return { center, fill, verdict };
        });
        const ambiguous = rings.flatMap((r, j) => (r.verdict === "ambiguous" ? [String.fromCharCode(65 + j)] : []));
        if (!ringRow.error && ambiguous.length) {
            res.reasons.push(
                `Q${payload.firstQuestionIndex + i + 1}: ambiguous mark on ${ambiguous.join(", ")} (fill ${rings
                    .filter((r) => r.verdict === "ambiguous")
                    .map((r) => r.fill.toFixed(2))
                    .join(", ")})`,
            );
        }
        res.questions!.push({
            index: payload.firstQuestionIndex + i,
            row,
            choices: rings.length,
            marked: rings.flatMap((r, j) => (r.verdict === "marked" ? [j] : [])),
            rings,
        });
    });

    if (payload.pageNumber === 1) {
        const r = rangeRect(L.fields.name, L);
        const pad = 6;
        const a = pageToCanvas(canvas, { x: r.x - pad, y: r.y - pad });
        const b = pageToCanvas(canvas, { x: r.x + r.w + pad, y: r.y + r.h + pad });
        res.nameCrop = await encodePng(crop(reg.rectified, a.x, a.y, b.x - a.x, b.y - a.y));
    }
    return res;
}
