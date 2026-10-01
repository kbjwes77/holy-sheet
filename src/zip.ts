// Reads page images from a zip, keeping the stored entry order (grouping depends on it).
import { unzipSync } from "fflate";

export interface ZipImage {
    name: string;
    bytes: Uint8Array;
}

export class ZipError extends Error {
    override name = "ZipError";
}

const IMAGE = /\.(jpe?g|png)$/i;

export function isPageImage(path: string): boolean {
    if (path.endsWith("/")) return false;
    if (path.startsWith("__MACOSX/") || path.includes("/__MACOSX/")) return false;
    const base = path.slice(path.lastIndexOf("/") + 1);
    return !base.startsWith(".") && IMAGE.test(base);
}

export function readZipImages(bytes: Uint8Array): ZipImage[] {
    const order: string[] = [];
    let files: Record<string, Uint8Array>;
    try {
        // fflate calls the filter in central-directory order; record it rather than trusting
        // object key order (integer-like names would be reordered).
        files = unzipSync(bytes, {
            filter: (f) => {
                const keep = isPageImage(f.name);
                if (keep) order.push(f.name);
                return keep;
            },
        });
    } catch (e) {
        throw new ZipError(`could not read zip: ${(e as Error).message}`);
    }
    return order.map((name) => ({ name, bytes: files[name]! }));
}
