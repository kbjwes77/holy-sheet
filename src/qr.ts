// QR decoding via zxing-wasm, with the .wasm loaded from node_modules (never a CDN).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import type { Gray } from "./image.ts";
import type { Point } from "./layout.ts";

let ready: Promise<unknown> | undefined;

function init(): Promise<unknown> {
    if (!ready) {
        const path = createRequire(import.meta.url).resolve("zxing-wasm/reader/zxing_reader.wasm");
        const bin = readFileSync(path);
        ready = prepareZXingModule({
            overrides: { wasmBinary: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer },
            fireImmediately: true,
        });
    }
    return ready;
}

export interface QrHit {
    bytes: Uint8Array;
    /** Symbol corners in image pixels, in the symbol's own TL, TR, BR, BL order. */
    corners: [Point, Point, Point, Point];
}

async function decodeRegion(img: Gray, x0: number, y0: number, w: number, h: number): Promise<QrHit | undefined> {
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    w = Math.min(img.width - x0, Math.floor(w));
    h = Math.min(img.height - y0, Math.floor(h));
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const v = img.data[(y0 + y) * img.width + x0 + x]!;
            const o = (y * w + x) * 4;
            rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
            rgba[o + 3] = 255;
        }
    }
    const results = await readBarcodes(
        { data: rgba, width: w, height: h, colorSpace: "srgb" } as unknown as Parameters<typeof readBarcodes>[0],
        { formats: ["QRCode"], tryHarder: true, maxNumberOfSymbols: 1 },
    );
    const r = results.find((r) => r.isValid);
    if (!r) return undefined;
    const p = r.position;
    const at = (q: Point) => ({ x: q.x + x0, y: q.y + y0 });
    return { bytes: new Uint8Array(r.bytes), corners: [at(p.topLeft), at(p.topRight), at(p.bottomRight), at(p.bottomLeft)] };
}

/** Tries the expected header region (top-right) first, then the whole image. */
export async function decodeQr(img: Gray): Promise<QrHit | undefined> {
    await init();
    return (
        (await decodeRegion(img, img.width * 0.5, 0, img.width * 0.5, img.height * 0.35)) ??
        (await decodeRegion(img, 0, 0, img.width, img.height))
    );
}
