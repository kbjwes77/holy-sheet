// Homography fitting (normalized DLT, least squares) and application.
import type { Point } from "./layout.ts";

/** Row-major 3×3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export function apply(H: Mat3, p: Point): Point {
    const w = H[6] * p.x + H[7] * p.y + H[8];
    return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

export function multiply(A: Mat3, B: Mat3): Mat3 {
    const out = new Array<number>(9).fill(0) as Mat3;
    for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++) out[r * 3 + c] = A[r * 3]! * B[c]! + A[r * 3 + 1]! * B[3 + c]! + A[r * 3 + 2]! * B[6 + c]!;
    return out;
}

export function invert(m: Mat3): Mat3 {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) throw new Error("singular homography");
    const k = 1 / det;
    return [
        A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
        B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
        C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
    ];
}

/** Similarity that moves the centroid to the origin and the mean distance to √2. */
function normalizer(pts: readonly Point[]): Mat3 {
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
        cx += p.x;
        cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;
    let d = 0;
    for (const p of pts) d += Math.hypot(p.x - cx, p.y - cy);
    const s = d > 0 ? (Math.SQRT2 * pts.length) / d : 1;
    return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/** Solves the n×n system in place by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
    const n = b.length;
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
        if (Math.abs(A[piv]![col]!) < 1e-14) throw new Error("degenerate point configuration");
        [A[col], A[piv]] = [A[piv]!, A[col]!];
        [b[col], b[piv]] = [b[piv]!, b[col]!];
        for (let r = col + 1; r < n; r++) {
            const k = A[r]![col]! / A[col]![col]!;
            for (let c = col; c < n; c++) A[r]![c]! -= k * A[col]![c]!;
            b[r]! -= k * b[col]!;
        }
    }
    const x = new Array<number>(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
        let s = b[r]!;
        for (let c = r + 1; c < n; c++) s -= A[r]![c]! * x[c]!;
        x[r] = s / A[r]![r]!;
    }
    return x;
}

/** Least-squares homography mapping `src[i]` → `dst[i]` (needs ≥ 4 points, weights optional). */
export function fitHomography(src: readonly Point[], dst: readonly Point[], weights?: readonly number[]): Mat3 {
    if (src.length !== dst.length || src.length < 4) throw new Error("need at least 4 point pairs");
    const Ts = normalizer(src);
    const Td = normalizer(dst);
    const A: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
    const b = new Array<number>(8).fill(0);
    const addRow = (row: number[], rhs: number, w: number) => {
        for (let i = 0; i < 8; i++) {
            for (let j = 0; j < 8; j++) A[i]![j]! += w * row[i]! * row[j]!;
            b[i]! += w * row[i]! * rhs;
        }
    };
    for (let k = 0; k < src.length; k++) {
        const s = apply(Ts, src[k]!);
        const d = apply(Td, dst[k]!);
        const w = weights?.[k] ?? 1;
        addRow([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x], d.x, w);
        addRow([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y], d.y, w);
    }
    const h = solve(A, b);
    const Hn: Mat3 = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
    const H = multiply(invert(Td), multiply(Hn, Ts));
    const s = H[8];
    return H.map((v) => v / s) as Mat3;
}

/**
 * Fits, then repeatedly drops the worst point while its reprojection error exceeds `maxError`
 * (in dst units). `keep` marks points that must never be dropped.
 */
export function fitHomographyRobust(
    src: readonly Point[],
    dst: readonly Point[],
    maxError: number,
    keep: readonly boolean[] = [],
    fit: (src: Point[], dst: Point[]) => Mat3 = fitHomography,
): { H: Mat3; inliers: boolean[] } {
    const inliers = src.map(() => true);
    for (;;) {
        const idx = inliers.flatMap((ok, i) => (ok ? [i] : []));
        const H = fit(idx.map((i) => src[i]!), idx.map((i) => dst[i]!));
        let worst = -1;
        let worstErr = maxError;
        for (const i of idx) {
            if (keep[i]) continue;
            const p = apply(H, src[i]!);
            const err = Math.hypot(p.x - dst[i]!.x, p.y - dst[i]!.y);
            if (err > worstErr) {
                worstErr = err;
                worst = i;
            }
        }
        if (worst < 0 || idx.length <= 4) return { H, inliers };
        inliers[worst] = false;
    }
}

/** Least-squares affine map `src[i]` → `dst[i]` (needs ≥ 3 points), as a Mat3. */
export function fitAffine(src: readonly Point[], dst: readonly Point[]): Mat3 {
    if (src.length !== dst.length || src.length < 3) throw new Error("need at least 3 point pairs");
    // Solve the two 3×3 normal systems for [a b c] and [d e f].
    const AtA: number[][] = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    const bx = [0, 0, 0];
    const by = [0, 0, 0];
    for (let k = 0; k < src.length; k++) {
        const r = [src[k]!.x, src[k]!.y, 1];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) AtA[i]![j]! += r[i]! * r[j]!;
            bx[i]! += r[i]! * dst[k]!.x;
            by[i]! += r[i]! * dst[k]!.y;
        }
    }
    const x = solve(AtA.map((r) => [...r]), bx);
    const y = solve(AtA.map((r) => [...r]), by);
    return [x[0]!, x[1]!, x[2]!, y[0]!, y[1]!, y[2]!, 0, 0, 1];
}

/**
 * Perspective needs anchors spread over the page; with clustered points (e.g. only the header)
 * the perspective terms are ill-conditioned and extrapolate wildly, so fall back to affine.
 */
export function fitPageTransform(src: readonly Point[], dst: readonly Point[], pageW: number, pageH: number): Mat3 {
    const xs = src.map((p) => p.x);
    const ys = src.map((p) => p.y);
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const spreadY = Math.max(...ys) - Math.min(...ys);
    return spreadX > 0.5 * pageW && spreadY > 0.5 * pageH && src.length >= 5 ? fitHomography(src, dst) : fitAffine(src, dst);
}
