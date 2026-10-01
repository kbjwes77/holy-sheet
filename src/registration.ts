// Page registration: QR corners → initial homography, then corner squares and timing markers
// refine it. All detection happens on rectified canvases, where sizes are known.
import { apply, fitHomographyRobust, fitPageTransform, type Mat3 } from "./geometry.ts";
import { blobs, darkness, makeCanvas, pageToCanvas, canvasToPage, warp, warpPatch, type Canvas, type FloatMap, type Gray } from "./image.ts";
import { LAYOUT, type CellRange, type LayoutSpec, type Point, markerRect, qrSymbolCorners, qrSymbolRect, rangeRect, rectCenter } from "./layout.ts";
import { findMarkers, INK, type Marker, type MarkerScan } from "./marks.ts";

export const RECT_SCALE = 1.5;
export const RECT_PAD = 30;

export interface Registration {
    /** Page units → source image pixels. */
    H: Mat3;
    canvas: Canvas;
    rectified: Gray;
    dark: FloatMap;
    markers: MarkerScan;
    /** Corner squares found (canvas px of the final rectification), TL, TR, BR, BL; null if missed. */
    corners: (Point | null)[];
    /** Corner squares used for the homography. */
    cornersFound: number;
}

function rectify(img: Gray, H: Mat3, c: Canvas) {
    const rectified = warp(img, H, c);
    // Blocks of ~11 page units; 3 dilations ignore ink up to ~75 units wide (corner squares are 35).
    return { rectified, dark: darkness(rectified, 16, 3) };
}

/**
 * Finds one corner square near where H predicts it, by rectifying just that neighbourhood.
 * Returns its centre in source-image px.
 */
function findCornerSquare(img: Gray, H: Mat3, c: Canvas, range: CellRange, reachCells: number, L: LayoutSpec): Point | null {
    const s = c.scale;
    const r = rangeRect(range, L);
    const p = pageToCanvas(c, rectCenter(r));
    const expArea = r.w * r.h * s * s;
    const reach = reachCells * L.cellW * s;
    const margin = 48; // context so the paper estimate isn't fooled by the square itself
    const x0 = p.x - reach - margin;
    const y0 = p.y - reach - margin;
    const size = 2 * (reach + margin);
    const patch = warpPatch(img, H, c, x0, y0, size, size);
    const dark = darkness(patch, 16, 3);
    const cand = blobs(dark, margin, margin, size - margin, size - margin, INK).filter((b) => {
        const w = b.maxX - b.minX + 1;
        const h = b.maxY - b.minY + 1;
        return !b.clipped && b.area > 0.5 * expArea && b.area < 1.8 * expArea && w / h > 0.6 && w / h < 1.6 && b.area / (w * h) > 0.7;
    });
    const local = { x: p.x - Math.round(x0), y: p.y - Math.round(y0) };
    cand.sort((a, b) => Math.hypot(a.cx - local.x, a.cy - local.y) - Math.hypot(b.cx - local.x, b.cy - local.y));
    const best = cand[0];
    if (!best) return null;
    return apply(H, canvasToPage(c, { x: best.cx + Math.round(x0), y: best.cy + Math.round(y0) }));
}

/** Corner squares as found in the final rectification (canvas px), for diagnostics. */
function cornersOnCanvas(dark: FloatMap, c: Canvas, L: LayoutSpec): (Point | null)[] {
    const s = c.scale;
    return L.cornerSquares.map((range) => {
        const r = rangeRect(range, L);
        const p = pageToCanvas(c, rectCenter(r));
        const reach = 2 * L.cellW * s;
        const best = blobs(dark, p.x - reach, p.y - reach, p.x + reach, p.y + reach, INK).sort((a, b) => b.area - a.area)[0];
        return best && best.area > 0.5 * r.w * r.h * s * s ? { x: best.cx, y: best.cy } : null;
    });
}

export interface RegisterInput {
    img: Gray;
    /** QR symbol corners in image px, TL, TR, BR, BL (symbol orientation). */
    qrCorners: Point[];
    layout?: LayoutSpec;
}

export function register({ img, qrCorners, layout: L = LAYOUT }: RegisterInput): Registration {
    const canvas = makeCanvas(L.pageWidth, L.pageHeight, RECT_SCALE, RECT_PAD);
    const qrPage = qrSymbolCorners(L);

    // 1. QR only.
    const fit = (s: Point[], d: Point[]) => fitPageTransform(s, d, L.pageWidth, L.pageHeight);
    const H0 = fit(qrPage, qrCorners);
    // Image px per page unit, for tolerances in image space.
    const pxPerUnit = Math.hypot(qrCorners[1]!.x - qrCorners[0]!.x, qrCorners[1]!.y - qrCorners[0]!.y) / L.qrSymbolSide;
    const tol = 0.5 * L.cellW * pxPerUnit;

    // 2. Corner squares, nearest the QR first, refitting after each so the prediction for the
    // next one improves.
    const src: Point[] = [...qrPage];
    const dst: Point[] = [...qrCorners];
    const keep: boolean[] = [true, true, true, true];
    const qrCenter = rectCenter(qrSymbolRect(L));
    const order = L.cornerSquares
        .map((range, i) => ({ i, d: Math.hypot(rectCenter(rangeRect(range, L)).x - qrCenter.x, rectCenter(rangeRect(range, L)).y - qrCenter.y) }))
        .sort((a, b) => a.d - b.d);
    let H1 = H0;
    for (const [n, { i }] of order.entries()) {
        // The far corners can be several cells from an affine guess on a perspective photo;
        // nothing else on the page passes the size and shape filter, so search widely.
        const hit = findCornerSquare(img, H1, canvas, L.cornerSquares[i]!, n < 2 ? 8 : 16, L);
        if (!hit) continue;
        src.push(rectCenter(rangeRect(L.cornerSquares[i]!, L)));
        dst.push(hit);
        keep.push(false);
        H1 = src.length >= 6 ? fitHomographyRobust(src, dst, tol, keep, fit).H : fit(src, dst);
    }

    // 3. Timing markers. Two passes: markers found with H1 refine it, and the refined fit finds
    // any the first pass missed far from the anchors.
    let H = H1;
    let final = rectify(img, H, canvas);
    let markers = findMarkers(final.dark, canvas, L);
    for (let pass = 0; pass < 2; pass++) {
        const s2 = [...src];
        const d2 = [...dst];
        const k2 = [...keep];
        for (const m of markers.markers) {
            s2.push(rectCenter(markerRect(m.row, L)));
            d2.push(apply(H, canvasToPage(canvas, m.center)));
            k2.push(false);
        }
        if (s2.length < 6) break;
        H = fitHomographyRobust(s2, d2, tol, k2, fit).H;
        final = rectify(img, H, canvas);
        markers = findMarkers(final.dark, canvas, L);
    }
    const corners = cornersOnCanvas(final.dark, canvas, L);
    return { H, canvas, rectified: final.rectified, dark: final.dark, markers, corners, cornersFound: src.length - 4 };
}

export type { Marker };
