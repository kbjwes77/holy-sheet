// The oil-paint engine behind the landing page paintings (see scripts/paint.ts).
// Every stroke is simulated bristle by bristle: each bristle carries its own paint load and color, runs dry along
// the stroke (so the tail breaks up on the canvas tooth), drags wet paint from underneath, and leaves paint height
// behind. Saving lights that height from the upper left for the impasto relief.
// Scenes author coordinates at full size; `scale` renders smaller for quick previews.
import sharp from "sharp";

export type Rgb = [number, number, number];
export type Pt = [number, number];

// ---- randomness and noise -------------------------------------------------------------------------------------

function mulberry32(a: number) {
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hash2(ix: number, iy: number, s: number): number {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}
export function vnoise(x: number, y: number, s: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
export function fbm(x: number, y: number, s: number, octaves = 4): number {
    let sum = 0, norm = 0, amp = 0.5, f = 1;
    for (let i = 0; i < octaves; i++) {
        sum += amp * vnoise(x * f, y * f, s + i * 101);
        norm += amp;
        amp *= 0.5;
        f *= 2.03;
    }
    return sum / norm;
}

export const clamp = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const sstep = (a: number, b: number, v: number) => {
    const t = clamp((v - a) / (b - a));
    return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---- palette: the site's brand colors plus the reference painting's whites, ultramarine and greens ---------------

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export const C = {
    ink: hex("#0b1747"),
    navy: hex("#13258a"),
    ultra: hex("#1d2fc0"),
    cobalt: hex("#1a3fd1"),
    royal: hex("#2f5fe3"),
    sky: hex("#4aa8e6"),
    pale: hex("#a8d4f4"),
    white: hex("#f6faff"),
    cream: hex("#fff4d6"),
    sea: hex("#12a58f"),
    teal: hex("#1f9d8f"),
    turq: hex("#28b5c8"),
    aqua: hex("#74d7de"),
    mint: hex("#7de3b0"),
    lime: hex("#b9d63a"),
    sap: hex("#5f9e3a"),
    sun: hex("#f4b63a"),
    sunDeep: hex("#c98d14"),
    lemon: hex("#f8d65c"),
    coral: hex("#e2523f"),
    orange: hex("#ef8a2a"),
};

// ---- paths --------------------------------------------------------------------------------------------------------

function catmull(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
    const t2 = t * t, t3 = t2 * t;
    const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

/** Points every `step` px along a Catmull-Rom spline through `ctrl`. */
export function samplePath(ctrl: Pt[], step: number): Pt[] {
    const P = [ctrl[0]!, ...ctrl, ctrl[ctrl.length - 1]!];
    const dense: Pt[] = [];
    for (let i = 1; i < P.length - 2; i++) for (let k = 0; k < 32; k++) dense.push(catmull(P[i - 1]!, P[i]!, P[i + 1]!, P[i + 2]!, k / 32));
    dense.push(ctrl[ctrl.length - 1]!);
    const out: Pt[] = [dense[0]!];
    let carry = 0;
    for (let i = 1; i < dense.length; i++) {
        const [ax, ay] = dense[i - 1]!, [bx, by] = dense[i]!;
        const seg = Math.hypot(bx - ax, by - ay);
        let d = step - carry;
        while (d <= seg) {
            const t = d / seg;
            out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
            d += step;
        }
        carry = seg - (d - step);
    }
    return out;
}

/** The point a fraction `u` of the way along a curve. */
export function along(curve: Pt[], u: number): Pt {
    const p = samplePath(curve, 2);
    return p[Math.min(p.length - 1, Math.round(u * (p.length - 1)))]!;
}

/** A gesture from `from`, heading `deg` degrees (0 = right, negative = up), `bend` px of sideways bow. */
export function sweep(from: Pt, deg: number, length: number, bend: number, pts = 5): Pt[] {
    const a = (deg * Math.PI) / 180;
    const dx = Math.cos(a), dy = Math.sin(a);
    return Array.from({ length: pts }, (_, i) => {
        const t = i / (pts - 1);
        const b = Math.sin(Math.PI * t) * bend;
        return [from[0] + dx * length * t - dy * b, from[1] + dy * length * t + dx * b] as Pt;
    });
}

// ---- the painting -------------------------------------------------------------------------------------------------

export interface Stroke {
    path: Pt[]; // control points, passed through by a Catmull-Rom spline
    width: number;
    colors: Rgb[]; // loaded across the brush from one edge to the other, in streaks
    mixing?: number; // how much the loaded colors wander across the width (0 = clean bands)
    load?: number; // 1 = fully loaded; lower starts drier
    reach?: number; // px before the paint runs out
    pickup?: number; // how much wet paint underneath gets dragged along
    thick?: number; // impasto
    knife?: boolean; // palette knife: dense, hard-edged, flattens what's under it, ridges at the sides
    taper?: [number, number]; // pressure ramp in/out as fractions of the length
    wobble?: number; // px of hand wobble
    opacity?: number;
}

export interface PaintingOptions {
    width: number;
    height: number;
    seed: number;
    scale?: number;
    /** Start from a bare, transparent canvas (saved as PNG with alpha) instead of an underpainting. */
    transparent?: boolean;
}

export type Painting = ReturnType<typeof createPainting>;

const STEP = 0.8;

export function createPainting(o: PaintingOptions) {
    const SCALE = o.scale ?? 1;
    const W = Math.round(o.width * SCALE);
    const H = Math.round(o.height * SCALE);
    const N = W * H;
    const rnd = mulberry32(o.seed);
    const range = (a: number, b: number) => a + rnd() * (b - a);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const chance = (p: number) => rnd() < p;

    const col = new Float32Array(N * 3); // paint color, sRGB 0..1
    const alpha = new Float32Array(N).fill(o.transparent ? 0 : 1);
    const ht = new Float32Array(N); // paint thickness
    const tooth = new Float32Array(N); // how far each spot of canvas stands up to catch a dry brush
    const weave = new Float32Array(N);

    {
        const period = Math.max(2.5, 5.2 * SCALE);
        const k = (2 * Math.PI) / period;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                const wob = 1.4 * vnoise(x * 0.04, y * 0.04, 3);
                const wv = 0.5 + 0.5 * Math.sin((x + wob) * k) * Math.sin((y - wob) * k);
                const grain = fbm(x / (2.6 * SCALE + 0.4), y / (2.6 * SCALE + 0.4), 11, 2);
                const coarse = fbm(x / (45 * SCALE), y / (45 * SCALE), 13, 3);
                weave[i] = wv;
                tooth[i] = clamp(0.5 + (0.25 * wv + 0.35 * grain + 0.4 * coarse - 0.5) * 2.4);
            }
        }
    }

    /** A thin underpainting, so dry-brush gaps show color rather than bare canvas. */
    function fill(color: (x: number, y: number) => Rgb): void {
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const c = color(x / SCALE, y / SCALE);
                const i = y * W + x;
                col[i * 3] = c[0];
                col[i * 3 + 1] = c[1];
                col[i * 3 + 2] = c[2];
                alpha[i] = 1;
                ht[i] = 0.05;
            }
        }
    }

    function stroke(s: Stroke): void {
        const knife = !!s.knife;
        const pts = samplePath(s.path.map(([x, y]) => [x * SCALE, y * SCALE] as Pt), STEP);
        const n = pts.length;
        if (n < 4) return;
        const len = n * STEP;
        const w = s.width * SCALE;
        const [tin, tout] = s.taper ?? (knife ? [0.03, 0.12] : [0.08, 0.3]);
        const pickup = s.pickup ?? 0.03;
        const thick = s.thick ?? 0.5;
        const opacity = s.opacity ?? 0.92;
        const wobble = (s.wobble ?? 6) * SCALE;
        const sseed = Math.floor(rnd() * 1e6);
        const reach = (s.reach ?? 1e5) * SCALE;
        const mixing = s.mixing ?? 0.25;

        const count = Math.max(5, Math.round(s.width / (knife ? 1.7 : 2.6)));
        const r = Math.max(0.75, (w / count) * (knife ? 0.95 : 0.85));
        const bristles = Array.from({ length: count }, (_, i) => {
            const off = ((i + 0.5) / count) * 2 - 1 + (rnd() - 0.5) * (1.6 / count);
            const u = clamp((off + 1) / 2 + (fbm(off * 2.5, sseed % 997, sseed) - 0.5) * mixing * 2 + (rnd() - 0.5) * mixing * 0.4);
            const f = u * (s.colors.length - 1);
            const ci = Math.min(s.colors.length - 2, Math.floor(f));
            let c = s.colors.length === 1 ? s.colors[0]! : mix(s.colors[ci]!, s.colors[ci + 1]!, sstep(0.2, 0.8, f - ci));
            const j = 1 + (rnd() - 0.5) * 0.08;
            c = [c[0] * j, c[1] * j, c[2] * j];
            const edge = Math.abs(off);
            return {
                off,
                c,
                base: [...c] as Rgb,
                // Bristles touch down and lift off at slightly different points, so the ends are ragged, not square.
                start: rnd() * Math.min(40 * SCALE, len * 0.06) + (knife ? (off + 1) * 0.5 * Math.min(30 * SCALE, len * 0.05) : edge * 25 * SCALE),
                end: len - rnd() * Math.min(60 * SCALE, len * 0.1) - (knife ? 0 : edge * 40 * SCALE),
                load: (s.load ?? 1) * (0.72 + rnd() * 0.56) * (knife ? 1 : 1 - 0.4 * edge * edge),
                reach: reach * (0.55 + rnd() * 0.9),
                h: 0.5 + rnd(),
                s: Math.floor(rnd() * 1e6),
                ridge: knife && edge > 0.8 ? 2.4 : knife ? 0.7 : 1,
            };
        });

        for (let k = 0; k < n; k++) {
            const t = k / (n - 1);
            const d = k * STEP;
            const a = pts[Math.max(0, k - 2)]!, b = pts[Math.min(n - 1, k + 2)]!;
            let tx = b[0] - a[0], ty = b[1] - a[1];
            const tl = Math.hypot(tx, ty) || 1;
            tx /= tl;
            ty /= tl;
            const nx = -ty, ny = tx;
            const wob = (vnoise(d / (160 * SCALE), 0.5, sseed) - 0.5) * 2 * wobble;
            const cx = pts[k]![0] + nx * wob, cy = pts[k]![1] + ny * wob;
            const press = Math.min(sstep(0, tin, t), 1 - sstep(1 - tout, 1, t));
            const half = (knife ? 0.92 + 0.08 * press : 0.5 + 0.5 * press) * w * 0.5;
            const inkPress = knife ? 0.6 + 0.4 * press : press;
            const boost = 1 + 1.6 * Math.max(0, 1 - d / (36 * SCALE)); // the blob of paint where the stroke lands

            for (const br of bristles) {
                if (d < br.start || d > br.end) continue;
                const ink = br.load * inkPress * Math.pow(Math.max(0, 1 - d / br.reach), 0.7);
                if (ink < 0.03) continue;
                const px = cx + nx * br.off * half, py = cy + ny * br.off * half;
                const sn = vnoise(d / (22 * SCALE + 2), 0.5, br.s);

                const ci = Math.floor(px), cj = Math.floor(py);
                if (ci >= 0 && cj >= 0 && ci < W && cj < H && pickup > 0) {
                    // Wet paint underneath smears into the bristle while its own load keeps pulling it back,
                    // so a stroke drags at most about a quarter of what it crosses.
                    const i = cj * W + ci, q = i * 3;
                    const pk = pickup * alpha[i]!;
                    for (let c = 0; c < 3; c++) br.c[c] = br.c[c]! + (col[q + c]! - br.c[c]!) * pk + (br.base[c]! - br.c[c]!) * pickup * 3;
                }

                const x0 = Math.max(0, Math.floor(px - r - 1)), x1 = Math.min(W - 1, Math.ceil(px + r + 1));
                const y0 = Math.max(0, Math.floor(py - r - 1)), y1 = Math.min(H - 1, Math.ceil(py + r + 1));
                for (let y = y0; y <= y1; y++) {
                    for (let x = x0; x <= x1; x++) {
                        const dist = Math.hypot(x + 0.5 - px, y + 0.5 - py);
                        const cov = 1 - sstep(r - 0.6, r + 0.4, dist);
                        if (cov <= 0) continue;
                        const i = y * W + x;
                        const grip = clamp(0.5 * tooth[i]! + 0.35 * sn + 0.15 * Math.min(1, ht[i]! * 0.3));
                        const al = cov * opacity * sstep(-0.14, 0.14, ink * 1.12 - (1 - grip));
                        if (al <= 0.002) continue;
                        // On bare canvas the new paint is all there is; over paint it blends by its coverage.
                        const a0 = alpha[i]!;
                        const na = a0 + (1 - a0) * al;
                        const wn = al / na;
                        alpha[i] = na;
                        const q = i * 3;
                        col[q] = col[q]! + (br.c[0] - col[q]!) * wn;
                        col[q + 1] = col[q + 1]! + (br.c[1] - col[q + 1]!) * wn;
                        col[q + 2] = col[q + 2]! + (br.c[2] - col[q + 2]!) * wn;
                        const dh = thick * Math.min(ink, 1.3) * boost;
                        ht[i] = knife ? ht[i]! * (1 - 0.6 * al) + al * dh * br.ridge : Math.min(6, ht[i]! + al * dh * br.h * 0.5);
                    }
                }
            }
        }
    }

    /** Lights the paint relief and writes a JPEG, or a PNG for a transparent painting or a .png path. */
    async function save(out: string, quality = 84): Promise<void> {
        const blurred = new Float32Array(N);
        const tmp = new Float32Array(N);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x;
            tmp[i] = (ht[i - (x > 0 ? 1 : 0)]! + ht[i]! + ht[i + (x < W - 1 ? 1 : 0)]!) / 3;
        }
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x;
            blurred[i] = (tmp[i - (y > 0 ? W : 0)]! + tmp[i]! + tmp[i + (y < H - 1 ? W : 0)]!) / 3;
        }
        const bump = 1.1 * SCALE;
        const L = [-0.5, -0.65, 0.57];
        const ll = Math.hypot(L[0]!, L[1]!, L[2]!);
        const lx = L[0]! / ll, ly = L[1]! / ll, lz = L[2]! / ll;
        const hx0 = lx, hy0 = ly, hz0 = lz + 1;
        const hl = Math.hypot(hx0, hy0, hz0);
        const hx = hx0 / hl, hy = hy0 / hl, hz = hz0 / hl;
        const specFlat = Math.pow(hz, 40);
        const ch = o.transparent ? 4 : 3;
        const px = Buffer.alloc(N * ch);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                const dx = (blurred[x < W - 1 ? i + 1 : i]! - blurred[x > 0 ? i - 1 : i]!) * bump;
                const dy = (blurred[y < H - 1 ? i + W : i]! - blurred[y > 0 ? i - W : i]!) * bump;
                const nl = Math.hypot(dx, dy, 1);
                const nx = -dx / nl, ny = -dy / nl, nz = 1 / nl;
                const diffuse = (nx * lx + ny * ly + nz * lz) / lz;
                const spec = Math.max(0, Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), 40) - specFlat);
                const thin = 1 - clamp(ht[i]! / 0.7);
                const shade = (1 + 0.5 * (diffuse - 1)) * (1 + 0.07 * thin * (weave[i]! - 0.5));
                for (let c = 0; c < 3; c++) {
                    const v = col[i * 3 + c]! * shade + spec * 0.28;
                    px[i * ch + c] = Math.round(clamp(v) * 255);
                }
                if (ch === 4) px[i * 4 + 3] = Math.round(clamp(alpha[i]!) * 255);
            }
        }
        const img = sharp(px, { raw: { width: W, height: H, channels: ch } });
        // A 256-color palette is indistinguishable here and about a fifth the size of a true-color PNG.
        await (o.transparent || out.endsWith(".png") ? img.png({ palette: true, quality: 92, effort: 10, dither: 0.8 }) : img.jpeg({ quality, mozjpeg: true })).toFile(out);
    }

    return { W, H, SCALE, rnd, range, pick, chance, fill, stroke, save };
}
