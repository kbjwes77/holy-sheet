// Timing-track markers, response rings and fill measurement on the rectified darkness map.
import { blobs, canvasToPage, pageToCanvas, type Canvas, type FloatMap } from "./image.ts";
import { LAYOUT, type LayoutSpec, type Point, colX, markerRect, ringCenters, ringRadius, rowY } from "./layout.ts";

/** Darkness above this counts as ink when finding printed features. */
export const INK = 0.4;

export interface Marker {
    row: number;
    /** Detected centre, canvas px. */
    center: Point;
}

export interface MarkerScan {
    markers: Marker[];
    /** Marker-sized blobs that don't sit on a grid row. */
    misaligned: Point[];
}

/** Finds marker blobs in the marker column and maps them to grid rows. */
export function findMarkers(dark: FloatMap, c: Canvas, L: LayoutSpec = LAYOUT): MarkerScan {
    const s = c.scale;
    const exp = markerRect(L.bodyFirstRow, L);
    const expArea = exp.w * exp.h * s * s;
    const a = pageToCanvas(c, { x: colX(L.marker.col, L) - 0.6 * L.cellW, y: rowY(L.bodyFirstRow, L) - 0.5 * L.cellH });
    const b = pageToCanvas(c, { x: colX(L.marker.col + 1, L) + 0.6 * L.cellW, y: rowY(L.bodyLastRow + 1, L) + 0.25 * L.cellH });
    const found = blobs(dark, a.x, a.y, b.x, b.y, INK).filter((bl) => {
        const w = bl.maxX - bl.minX + 1;
        const h = bl.maxY - bl.minY + 1;
        // Solid and wider than tall: rules out letters, digits and filled rings.
        return bl.area > 0.35 * expArea && bl.area < 2.2 * expArea && w / h > 1.1 && w / h < 4 && bl.area / (w * h) > 0.7;
    });
    const markers: Marker[] = [];
    const misaligned: Point[] = [];
    for (const bl of found) {
        const p = canvasToPage(c, { x: bl.cx, y: bl.cy });
        const rowF = (p.y - L.margin) / L.cellH + 0.5;
        const row = Math.round(rowF);
        if (Math.abs(rowF - row) > 0.3) misaligned.push({ x: bl.cx, y: bl.cy });
        else markers.push({ row, center: { x: bl.cx, y: bl.cy } });
    }
    markers.sort((m, n) => m.row - n.row);
    return { markers, misaligned };
}

/** Pixel offsets of an annulus [r0, r1]. */
function annulus(r0: number, r1: number): Int32Array {
    const pts: number[] = [];
    const R = Math.ceil(r1);
    for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
            const d = Math.hypot(dx, dy);
            if (d >= r0 && d <= r1) pts.push(dx, dy);
        }
    return Int32Array.from(pts);
}

function meanAt(map: FloatMap, offs: Int32Array, x: number, y: number): number {
    let s = 0;
    let n = 0;
    for (let i = 0; i < offs.length; i += 2) {
        const xx = x + offs[i]!;
        const yy = y + offs[i + 1]!;
        if (xx < 0 || yy < 0 || xx >= map.width || yy >= map.height) continue;
        s += map.data[yy * map.width + xx]!;
        n++;
    }
    return n ? s / n : 0;
}

export interface RingKernels {
    ring: Int32Array;
    outside: Int32Array;
    inner: Int32Array;
    radius: number;
}

export function ringKernels(c: Canvas, L: LayoutSpec = LAYOUT): RingKernels {
    const r = ringRadius(L) * c.scale;
    const half = Math.max(1.5, (L.ring.strokeWidth * c.scale) / 2 + 1);
    return {
        ring: annulus(r - half, r + half),
        outside: annulus(r + half + 2, r + half + 5),
        inner: annulus(0, r * L.ring.innerRadiusFrac),
        radius: r,
    };
}

/** How ring-like the neighbourhood of (x, y) is: outline darkness minus surrounding darkness. */
function ringScore(dark: FloatMap, k: RingKernels, x: number, y: number): number {
    return meanAt(dark, k.ring, x, y) - 0.5 * meanAt(dark, k.outside, x, y);
}

export interface RingRow {
    /** Ring centres, canvas px, left to right. */
    centers: Point[];
    /** Problem with the row, if any. */
    error?: string;
}

/** Minimum ring score for a ring outline to count as present. */
export const RING_PRESENT = 0.2;

/**
 * Scans a ring row from the ring start column to the right edge, counts ring outlines and checks
 * their positions against the layout's spacing for that count. `y` is the row centre (canvas px).
 */
export function findRings(dark: FloatMap, c: Canvas, row: number, y: number, k: RingKernels, L: LayoutSpec = LAYOUT): RingRow {
    const s = c.scale;
    const xStart = Math.floor(pageToCanvas(c, { x: colX(L.ring.startCol, L) - 0.5 * L.cellW, y: 0 }).x);
    const xEnd = Math.ceil(pageToCanvas(c, { x: colX(L.cols + 1, L), y: 0 }).x);
    const dyMax = Math.round(0.3 * L.cellH * s);
    const profile = new Float32Array(xEnd - xStart);
    for (let x = xStart; x < xEnd; x++) {
        let best = -Infinity;
        for (let dy = -dyMax; dy <= dyMax; dy += 2) best = Math.max(best, ringScore(dark, k, x, Math.round(y) + dy));
        profile[x - xStart] = best;
    }
    // Peaks, strongest first, suppressing neighbours closer than half the minimum pitch.
    const minPitch = Math.floor((L.ring.lastCol - L.ring.startCol) / (L.ring.maxChoices - 1)) * L.cellW * s;
    const order = Array.from(profile.keys())
        .filter((i) => profile[i]! > RING_PRESENT)
        .sort((a, b) => profile[b]! - profile[a]!);
    const peaks: number[] = [];
    for (const i of order) if (peaks.every((p) => Math.abs(p - i) > minPitch / 2)) peaks.push(i);
    peaks.sort((a, b) => a - b);

    // Refine each centre locally (absorbs curl the homography can't model).
    const centers = peaks.map((i) => {
        let best = { x: xStart + i, y: Math.round(y), s: -Infinity };
        const x0 = xStart + i;
        for (let dy = -dyMax; dy <= dyMax; dy++)
            for (let dx = -3; dx <= 3; dx++) {
                const sc = ringScore(dark, k, x0 + dx, Math.round(y) + dy);
                if (sc > best.s) best = { x: x0 + dx, y: Math.round(y) + dy, s: sc };
            }
        return { x: best.x, y: best.y };
    });

    const n = centers.length;
    if (n === 0) return { centers, error: `row ${row}: no rings found` };
    if (n > L.ring.maxChoices) return { centers, error: `row ${row}: ${n} rings found, more than ${L.ring.maxChoices}` };
    const expected = ringCenters(n, row, L).map((p) => pageToCanvas(c, p));
    const tol = 0.45 * L.cellW * s;
    for (let i = 0; i < n; i++) {
        const e = expected[i]!;
        const d = centers[i]!;
        if (Math.abs(d.x - e.x) > tol || Math.abs(d.y - e.y) > tol) {
            const at = canvasToPage(c, d);
            return {
                centers,
                error: `row ${row}: ${n} rings found but ring ${i + 1} is at col ${((at.x - L.margin) / L.cellW + 0.5).toFixed(1)}, expected col ${(
                    (canvasToPage(c, e).x - L.margin) / L.cellW +
                    0.5
                ).toFixed(1)}`,
            };
        }
    }
    return { centers };
}

/** Mean darkness inside the ring's inner disk. */
export function fillAt(dark: FloatMap, k: RingKernels, p: Point): number {
    return meanAt(dark, k.inner, Math.round(p.x), Math.round(p.y));
}

/** Median darkness inside the given marker blobs: the page's reference for solid print. */
export function inkReference(dark: FloatMap, markers: Marker[], c: Canvas, L: LayoutSpec = LAYOUT): number {
    const r = Math.max(1, Math.floor((L.marker.heightCells * L.cellH * c.scale) / 2 - 1.5));
    const offs: number[] = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -2 * r; dx <= 2 * r; dx++) offs.push(dx, dy);
    const kernel = Int32Array.from(offs);
    const vals = markers.map((m) => meanAt(dark, kernel, Math.round(m.center.x), Math.round(m.center.y))).sort((a, b) => a - b);
    return vals.length ? vals[vals.length >> 1]! : 0.85;
}
