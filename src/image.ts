// Grayscale image buffers: loading, warping and local darkness.
import sharp from "sharp";
import { apply, type Mat3 } from "./geometry.ts";

export interface Gray {
    data: Uint8Array;
    width: number;
    height: number;
}

/** A float map the same size as some Gray image, e.g. darkness in [0, 1]. */
export interface FloatMap {
    data: Float32Array;
    width: number;
    height: number;
}

/** EXIF-orients, grayscales, normalizes and downscales to `maxEdge` on the long side. */
export async function loadGray(bytes: Uint8Array, maxEdge = 2000): Promise<Gray> {
    const { data, info } = await sharp(bytes)
        .rotate()
        .grayscale()
        // Anchor black at the true minimum: on a nearly empty page the default 1st percentile is
        // antialiasing gray, and stretching it would turn light-gray print black.
        .normalize({ lower: 0, upper: 99 })
        .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
        .raw()
        .toBuffer({ resolveWithObject: true });
    if (info.channels !== 1) throw new Error(`expected 1 channel, got ${info.channels}`);
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

export function toSharp(img: Gray) {
    return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), {
        raw: { width: img.width, height: img.height, channels: 1 },
    });
}

export function crop(img: Gray, x: number, y: number, w: number, h: number): Gray {
    x = Math.max(0, Math.floor(x));
    y = Math.max(0, Math.floor(y));
    w = Math.min(img.width - x, Math.ceil(w));
    h = Math.min(img.height - y, Math.ceil(h));
    const data = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) data.set(img.data.subarray((y + r) * img.width + x, (y + r) * img.width + x + w), r * w);
    return { data, width: w, height: h };
}

/**
 * The rectified canvas: page coordinates [-pad, pageW + pad] × [-pad, pageH + pad] at `scale` px per
 * page unit. Pixel (u, v) ↔ page ((u + 0.5) / scale − pad, (v + 0.5) / scale − pad).
 */
export interface Canvas {
    scale: number;
    pad: number;
    width: number;
    height: number;
}

export function makeCanvas(pageW: number, pageH: number, scale: number, pad: number): Canvas {
    return { scale, pad, width: Math.round((pageW + 2 * pad) * scale), height: Math.round((pageH + 2 * pad) * scale) };
}

export function pageToCanvas(c: Canvas, p: { x: number; y: number }) {
    return { x: (p.x + c.pad) * c.scale - 0.5, y: (p.y + c.pad) * c.scale - 0.5 };
}

export function canvasToPage(c: Canvas, p: { x: number; y: number }) {
    return { x: (p.x + 0.5) / c.scale - c.pad, y: (p.y + 0.5) / c.scale - c.pad };
}

/** Warps `src` onto the canvas, given H mapping page units → source pixels. Outside → white. */
export function warp(src: Gray, H: Mat3, c: Canvas): Gray {
    return warpPatch(src, H, c, 0, 0, c.width, c.height);
}

/** Warps only the canvas window [x0, x0 + w) × [y0, y0 + h); pixel (u, v) is canvas (x0 + u, y0 + v). */
export function warpPatch(src: Gray, H: Mat3, c: Canvas, x0: number, y0: number, pw: number, ph: number): Gray {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    pw = Math.round(pw);
    ph = Math.round(ph);
    const out = new Uint8Array(pw * ph);
    const w = src.width;
    const h = src.height;
    const d = src.data;
    for (let v = 0; v < ph; v++) {
        for (let u = 0; u < pw; u++) {
            const p = apply(H, canvasToPage(c, { x: x0 + u, y: y0 + v }));
            const x = p.x - 0.5; // pixel centres
            const y = p.y - 0.5;
            let val = 255;
            if (x >= 0 && y >= 0 && x < w - 1 && y < h - 1) {
                const x0 = x | 0;
                const y0 = y | 0;
                const fx = x - x0;
                const fy = y - y0;
                const i = y0 * w + x0;
                val = (d[i]! * (1 - fx) + d[i + 1]! * fx) * (1 - fy) + (d[i + w]! * (1 - fx) + d[i + w + 1]! * fx) * fy;
            }
            out[v * pw + u] = val;
        }
    }
    return { data: out, width: pw, height: ph };
}

/**
 * Darkness relative to the local paper level: (paper − v) / paper, clamped to [0, 1]. Paper is
 * estimated as a dilated block maximum (so ink up to ~`block × (2·dilations + 1)` px wide is
 * ignored), smoothed and upsampled.
 */
export function darkness(img: Gray, block = 16, dilations = 3): FloatMap {
    const bw = Math.ceil(img.width / block);
    const bh = Math.ceil(img.height / block);
    let bg = new Float32Array(bw * bh);
    for (let y = 0; y < img.height; y++) {
        const row = (y / block) | 0;
        for (let x = 0; x < img.width; x++) {
            const i = row * bw + ((x / block) | 0);
            const v = img.data[y * img.width + x]!;
            if (v > bg[i]!) bg[i] = v;
        }
    }
    const filter = (src: Float32Array, op: "max" | "mean") => {
        const out = new Float32Array(src.length);
        for (let y = 0; y < bh; y++) {
            for (let x = 0; x < bw; x++) {
                let acc = op === "max" ? 0 : 0;
                let n = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= bh) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= bw) continue;
                        const v = src[yy * bw + xx]!;
                        if (op === "max") acc = Math.max(acc, v);
                        else acc += v;
                        n++;
                    }
                }
                out[y * bw + x] = op === "max" ? acc : acc / n;
            }
        }
        return out;
    };
    for (let i = 0; i < dilations; i++) bg = filter(bg, "max");
    bg = filter(filter(bg, "mean"), "mean");

    const out = new Float32Array(img.width * img.height);
    for (let y = 0; y < img.height; y++) {
        const by = Math.min(Math.max((y + 0.5) / block - 0.5, 0), bh - 1);
        const y0 = by | 0;
        const y1 = Math.min(y0 + 1, bh - 1);
        const fy = by - y0;
        for (let x = 0; x < img.width; x++) {
            const bx = Math.min(Math.max((x + 0.5) / block - 0.5, 0), bw - 1);
            const x0 = bx | 0;
            const x1 = Math.min(x0 + 1, bw - 1);
            const fx = bx - x0;
            const paper =
                (bg[y0 * bw + x0]! * (1 - fx) + bg[y0 * bw + x1]! * fx) * (1 - fy) +
                (bg[y1 * bw + x0]! * (1 - fx) + bg[y1 * bw + x1]! * fx) * fy;
            const v = img.data[y * img.width + x]!;
            out[y * img.width + x] = paper > 1 ? Math.min(1, Math.max(0, (paper - v) / paper)) : 0;
        }
    }
    return { data: out, width: img.width, height: img.height };
}

export async function encodePng(img: Gray): Promise<Uint8Array> {
    return new Uint8Array(await toSharp(img).png().toBuffer());
}

export interface Blob {
    area: number;
    cx: number;
    cy: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    /** True if the blob touches the search window's edge (so it may be clipped). */
    clipped: boolean;
}

/** 4-connected components of `map > threshold` inside the window [x0, x1) × [y0, y1). */
export function blobs(map: FloatMap, x0: number, y0: number, x1: number, y1: number, threshold: number): Blob[] {
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(map.width, Math.ceil(x1));
    y1 = Math.min(map.height, Math.ceil(y1));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return [];
    const seen = new Uint8Array(w * h);
    const stack: number[] = [];
    const out: Blob[] = [];
    for (let sy = 0; sy < h; sy++) {
        for (let sx = 0; sx < w; sx++) {
            const s = sy * w + sx;
            if (seen[s] || map.data[(y0 + sy) * map.width + x0 + sx]! <= threshold) continue;
            const b: Blob = { area: 0, cx: 0, cy: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, clipped: false };
            seen[s] = 1;
            stack.push(s);
            while (stack.length) {
                const i = stack.pop()!;
                const x = i % w;
                const y = (i / w) | 0;
                b.area++;
                b.cx += x;
                b.cy += y;
                if (x < b.minX) b.minX = x;
                if (x > b.maxX) b.maxX = x;
                if (y < b.minY) b.minY = y;
                if (y > b.maxY) b.maxY = y;
                if (x === 0 || y === 0 || x === w - 1 || y === h - 1) b.clipped = true;
                const push = (nx: number, ny: number) => {
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
                    const j = ny * w + nx;
                    if (seen[j] || map.data[(y0 + ny) * map.width + x0 + nx]! <= threshold) return;
                    seen[j] = 1;
                    stack.push(j);
                };
                push(x + 1, y);
                push(x - 1, y);
                push(x, y + 1);
                push(x, y - 1);
            }
            b.cx = b.cx / b.area + x0;
            b.cy = b.cy / b.area + y0;
            b.minX += x0;
            b.maxX += x0;
            b.minY += y0;
            b.maxY += y0;
            out.push(b);
        }
    }
    return out;
}
