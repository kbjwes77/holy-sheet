// Rasterizes sheets and degrades them like copier scans or phone photos.
import sharp from "sharp";
import { apply, fitHomography, invert, type Mat3 } from "../src/geometry.ts";
import { LAYOUT } from "../src/layout.ts";
import type { Rng } from "./rng.ts";

export interface Gray {
    data: Uint8Array;
    width: number;
    height: number;
}

/** Renders a page SVG (page units = 1/100 in) to grayscale at `dpi`. */
export async function rasterize(svg: string, dpi: number): Promise<Gray> {
    const { data, info } = await sharp(Buffer.from(svg), { density: (72 * dpi) / 100 })
        .flatten({ background: "#fff" })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

function sample(src: Gray, x: number, y: number, fallback: number): number {
    if (x < 0 || y < 0 || x > src.width - 1 || y > src.height - 1) return fallback;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, src.width - 1);
    const y1 = Math.min(y0 + 1, src.height - 1);
    const fx = x - x0;
    const fy = y - y0;
    const w = src.width;
    const d = src.data;
    const top = d[y0 * w + x0]! * (1 - fx) + d[y0 * w + x1]! * fx;
    const bot = d[y1 * w + x0]! * (1 - fx) + d[y1 * w + x1]! * fx;
    return top * (1 - fy) + bot * fy;
}

export interface PhotoOptions {
    outWidth: number;
    outHeight: number;
    /** Page corners in the output image, TL, TR, BR, BL. */
    corners: [number, number][];
    /** Vertical paper-curl amplitude in output px. */
    curl: number;
    background: number;
    /** Lighting: multiplicative gradient from `light[0]` (top-left) to `light[1]` (bottom-right). */
    light: [number, number];
    shadow?: { x: number; y: number; r: number; depth: number };
}

/** Projects the page onto a larger "desk" with perspective, curl and uneven light. */
export function photograph(src: Gray, o: PhotoOptions, rng: Rng): Gray {
    const srcCorners = [
        { x: 0, y: 0 },
        { x: src.width, y: 0 },
        { x: src.width, y: src.height },
        { x: 0, y: src.height },
    ];
    const H: Mat3 = invert(fitHomography(srcCorners, o.corners.map(([x, y]) => ({ x, y }))));
    const out = new Uint8Array(o.outWidth * o.outHeight);
    for (let y = 0; y < o.outHeight; y++) {
        for (let x = 0; x < o.outWidth; x++) {
            const p = apply(H, { x, y });
            // Curl: the page bows vertically, most strongly mid-page horizontally.
            const u = p.x / src.width;
            const py = p.y + o.curl * Math.sin(Math.PI * u) * (src.height / o.outHeight);
            const desk = o.background + (((x * 7 + y * 13) % 17) - 8);
            let v = sample(src, p.x, py, -1);
            if (v < 0) v = desk;
            const t = (x / o.outWidth + y / o.outHeight) / 2;
            let k = o.light[0] + (o.light[1] - o.light[0]) * t;
            if (o.shadow) {
                const d = Math.hypot(x - o.shadow.x, y - o.shadow.y) / o.shadow.r;
                if (d < 1) k *= 1 - o.shadow.depth * (1 - d * d);
            }
            out[y * o.outWidth + x] = Math.max(0, Math.min(255, v * k));
        }
    }
    void rng;
    return { data: out, width: o.outWidth, height: o.outHeight };
}

export function addNoise(img: Gray, sd: number, rng: Rng): Gray {
    const data = new Uint8Array(img.data.length);
    for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, img.data[i]! + rng.gauss(0, sd)));
    return { ...img, data };
}

export type Profile = "clean" | "scan" | "scan-flipped" | "photo";

export interface DistortResult {
    bytes: Uint8Array;
    ext: "png" | "jpg";
    profile: Profile;
}

function toSharp(img: Gray) {
    return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), {
        raw: { width: img.width, height: img.height, channels: 1 },
    });
}

/** Renders `svg` and applies a random distortion of the given profile. */
export async function capture(svg: string, profile: Profile, rng: Rng): Promise<DistortResult> {
    if (profile === "clean") {
        const img = await rasterize(svg, 150);
        return { bytes: new Uint8Array(await toSharp(img).png().toBuffer()), ext: "png", profile };
    }
    if (profile === "scan" || profile === "scan-flipped") {
        const dpi = rng.pick([150, 200, 300]);
        let img = await rasterize(svg, dpi);
        // Copier skew + slight scale error, then a little blur, noise and JPEG.
        const angle = rng.range(-5, 5) + (profile === "scan-flipped" ? 180 : 0);
        const scale = rng.range(0.97, 1.03);
        let s = toSharp(addNoise(img, rng.range(2, 6), rng))
            .rotate(angle, { background: "#fff" })
            .resize({ width: Math.round(img.width * scale) })
            .blur(rng.range(0.4, 1.0));
        const buf = await s.jpeg({ quality: rng.int(55, 90) }).toBuffer();
        return { bytes: new Uint8Array(buf), ext: "jpg", profile };
    }
    // Phone photo: 3024×4032-ish frame (downsized to keep fixtures small), page fills 60–85%.
    const img = await rasterize(svg, 200);
    const W = 1800;
    const Hh = 2400;
    const fill = rng.range(0.62, 0.8);
    const pw = W * fill;
    const ph = pw * (LAYOUT.pageHeight / LAYOUT.pageWidth);
    const cx = W / 2 + rng.range(-60, 60);
    const cy = Hh / 2 + rng.range(-60, 60);
    const j = () => rng.range(-0.06, 0.06) * pw; // perspective jitter
    const rot = (rng.range(-5, 5) * Math.PI) / 180;
    const base: [number, number][] = [
        [-pw / 2, -ph / 2],
        [pw / 2, -ph / 2],
        [pw / 2, ph / 2],
        [-pw / 2, ph / 2],
    ];
    // Keep the whole page in frame, as a person photographing a sheet would.
    let corners: [number, number][];
    do {
        corners = base.map(([x, y]) => [x * Math.cos(rot) - y * Math.sin(rot) + cx + j(), x * Math.sin(rot) + y * Math.cos(rot) + cy + j()]);
    } while (corners.some(([x, y]) => x < 20 || y < 20 || x > W - 20 || y > Hh - 20));
    let photo = photograph(
        img,
        {
            outWidth: W,
            outHeight: Hh,
            corners,
            curl: rng.range(-12, 12),
            background: rng.int(40, 110),
            light: [rng.range(0.75, 1.0), rng.range(0.7, 1.0)],
            shadow: rng.chance(0.5) ? { x: rng.range(0, W), y: rng.range(0, Hh), r: rng.range(400, 900), depth: rng.range(0.1, 0.3) } : undefined,
        },
        rng,
    );
    photo = addNoise(photo, rng.range(3, 8), rng);
    const buf = await toSharp(photo).blur(rng.range(0.5, 1.2)).jpeg({ quality: rng.int(60, 88) }).toBuffer();
    return { bytes: new Uint8Array(buf), ext: "jpg", profile };
}
