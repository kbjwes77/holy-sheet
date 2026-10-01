// Annotated diagnostic images: the rectified page with detections and verdicts overlaid.
import sharp from "sharp";
import type { Gray } from "./image.ts";
import type { PageResult } from "./pipeline.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const f = (n: number) => n.toFixed(1);

function rgbBase(img: Gray) {
    const rgb = new Uint8Array(img.width * img.height * 3);
    for (let i = 0; i < img.data.length; i++) {
        // Wash the page out a little so the overlay stands out.
        const v = 90 + (img.data[i]! * 165) / 255;
        rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v;
    }
    return sharp(Buffer.from(rgb), { raw: { width: img.width, height: img.height, channels: 3 } });
}

function textBlock(lines: string[], x: number, y: number, size: number): string {
    return lines
        .map(
            (l, i) =>
                `<text x="${x}" y="${y + i * size * 1.3}" font-family="Arial" font-size="${size}" fill="#d00" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(l)}</text>`,
        )
        .join("");
}

export async function renderDebug(page: PageResult): Promise<Uint8Array> {
    const reg = page.registration;
    if (!reg) {
        const img = page.source;
        if (!img) {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="200"><rect width="100%" height="100%" fill="#fff"/>${textBlock(page.reasons, 20, 40, 24)}</svg>`;
            return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
        }
        const size = Math.max(16, Math.round(img.width / 45));
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${img.width}" height="${img.height}">${textBlock(page.reasons, 20, size * 2, size)}</svg>`;
        return new Uint8Array(await rgbBase(img).composite([{ input: Buffer.from(svg) }]).png().toBuffer());
    }
    const { canvas, rectified } = reg;
    const parts: string[] = [];
    for (const c of reg.corners) {
        if (c) parts.push(`<circle cx="${f(c.x)}" cy="${f(c.y)}" r="10" fill="none" stroke="#06f" stroke-width="3"/>`);
    }
    for (const m of reg.markers.markers) {
        parts.push(
            `<circle cx="${f(m.center.x)}" cy="${f(m.center.y)}" r="6" fill="#06f"/>` +
                `<text x="${f(m.center.x + 16)}" y="${f(m.center.y - 8)}" font-family="Arial" font-size="11" fill="#06f">r${m.row}</text>`,
        );
    }
    for (const p of reg.markers.misaligned) parts.push(`<circle cx="${f(p.x)}" cy="${f(p.y)}" r="12" fill="none" stroke="#d00" stroke-width="3"/>`);
    const colors = { marked: "#0a0", blank: "#999", ambiguous: "#f60" } as const;
    for (const q of page.questions ?? []) {
        for (const r of q.rings) {
            const col = colors[r.verdict];
            parts.push(
                `<circle cx="${f(r.center.x)}" cy="${f(r.center.y)}" r="15" fill="none" stroke="${col}" stroke-width="${r.verdict === "blank" ? 1.5 : 3}"/>` +
                    `<text x="${f(r.center.x)}" y="${f(r.center.y + 28)}" font-family="Arial" font-size="11" text-anchor="middle" fill="${col}">${r.fill.toFixed(2)}</text>`,
            );
        }
    }
    for (const e of page.rowErrors ?? []) parts.push(textBlock([e.text], 120, e.y + 30, 14));
    parts.push(textBlock([page.file, ...(page.reasons.length ? page.reasons : ["OK"])], 20, 24, 16));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}">${parts.join("")}</svg>`;
    return new Uint8Array(await rgbBase(rectified).composite([{ input: Buffer.from(svg) }]).png().toBuffer());
}
