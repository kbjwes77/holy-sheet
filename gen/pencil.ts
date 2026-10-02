// Simulated student handwriting and pencil marks, as SVG fragments drawn over a rendered sheet.
import type { Point } from "../src/layout.ts";
import type { Rng } from "./rng.ts";

/**
 * - solid: a normal, confident fill
 * - sloppy: overflows the ring by up to 0.05 in and sits off-centre
 * - scribble: loose zigzag strokes, some paper showing through
 * - partial: only part of the ring shaded (should read ambiguous)
 * - light: faint shading (should read ambiguous)
 * - erased: a mostly-erased smudge (should read blank)
 */
export type MarkStyle = "solid" | "sloppy" | "scribble" | "partial" | "light" | "erased";

const f = (n: number) => +n.toFixed(2);

/** How far a sloppy mark spills past the ring outline, in page units (1/100 in). */
export const SLOPPY_OVERSHOOT: [number, number] = [1.5, 5];

function graphite(rng: Rng): string {
    const v = rng.int(0x22, 0x50);
    return `rgb(${v},${v},${v + 4})`;
}

function blob(c: Point, r: number, rng: Rng, jitter: number): string {
    const n = 18;
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr = r * (1 + rng.range(-jitter, jitter));
        pts.push(`${f(c.x + Math.cos(a) * rr)},${f(c.y + Math.sin(a) * rr)}`);
    }
    return pts.join(" ");
}

/** Zigzag strokes filling a disk, like back-and-forth pencil shading. */
function zigzag(c: Point, r: number, rng: Rng, spacing: number, coverage = 1): string {
    const angle = rng.range(-0.6, 0.6);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const pts: string[] = [];
    let flip = false;
    for (let y = -r; y <= -r + 2 * r * coverage; y += spacing) {
        const half = Math.sqrt(Math.max(0, r * r - y * y)) * rng.range(0.85, 1.1);
        const x = flip ? half : -half;
        flip = !flip;
        const px = c.x + x * cos - y * sin;
        const py = c.y + x * sin + y * cos;
        pts.push(`${f(px + rng.range(-0.6, 0.6))},${f(py + rng.range(-0.6, 0.6))}`);
    }
    return pts.join(" ");
}

export function markSvg(c: Point, r: number, style: MarkStyle, rng: Rng): string {
    const color = graphite(rng);
    const o = (dx: number) => ({ x: c.x + rng.range(-dx, dx) * r, y: c.y + rng.range(-dx, dx) * r });
    switch (style) {
        case "solid": {
            const cc = o(0.12);
            return (
                `<polygon points="${blob(cc, r * rng.range(0.95, 1.12), rng, 0.08)}" fill="${color}" opacity="${f(rng.range(0.8, 0.92))}"/>` +
                `<polyline points="${zigzag(cc, r * 0.95, rng, 1.6)}" fill="none" stroke="${color}" stroke-width="2" opacity="0.6" stroke-linejoin="round"/>`
            );
        }
        case "sloppy": {
            // Overshoot is absolute (page units), like a real pencil, not scaled with the bubble.
            const cc = o(0.3);
            return `<polygon points="${blob(cc, r + rng.range(SLOPPY_OVERSHOOT[0], SLOPPY_OVERSHOOT[1]), rng, 0.15)}" fill="${color}" opacity="${f(rng.range(0.75, 0.9))}"/>`;
        }
        case "scribble": {
            const cc = o(0.1);
            return `<polyline points="${zigzag(cc, r * 1.05, rng, 2.2)}" fill="none" stroke="${color}" stroke-width="2.4" opacity="0.9" stroke-linejoin="round"/>`;
        }
        case "partial": {
            const cc = o(0.05);
            return `<polyline points="${zigzag(cc, r * 0.9, rng, 1.5, rng.range(0.38, 0.46))}" fill="none" stroke="${color}" stroke-width="2.2" opacity="0.85" stroke-linejoin="round"/>`;
        }
        case "light": {
            const cc = o(0.08);
            return `<polygon points="${blob(cc, r, rng, 0.08)}" fill="${color}" opacity="${f(rng.range(0.29, 0.36))}"/>`;
        }
        case "erased": {
            const cc = o(0.1);
            return `<polygon points="${blob(cc, r * 1.1, rng, 0.12)}" fill="${color}" opacity="${f(rng.range(0.05, 0.09))}"/>`;
        }
    }
}

const HANDS = ["Ink Free", "Segoe Print", "Segoe Script"];

/** Handwritten text, baseline-left at `at`, with slight per-sheet slant and size variation. */
export function handwriting(text: string, at: Point, size: number, rng: Rng): string {
    const font = rng.pick(HANDS);
    const rot = rng.range(-2.5, 2.5);
    const s = size * rng.range(0.9, 1.1);
    const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return `<text x="${f(at.x)}" y="${f(at.y)}" font-family="${font}" font-size="${f(s)}" fill="${graphite(rng)}" transform="rotate(${f(rot)} ${f(at.x)} ${f(at.y)})">${esc}</text>`;
}

/** A stray pencil line somewhere in a rectangle (doodles, check marks next to questions). */
export function strayMark(x: number, y: number, w: number, h: number, rng: Rng): string {
    const x1 = x + rng.range(0, w);
    const y1 = y + rng.range(0, h);
    const x2 = x1 + rng.range(-30, 30);
    const y2 = y1 + rng.range(-8, 8);
    return `<path d="M${f(x1)} ${f(y1)} Q${f((x1 + x2) / 2 + rng.range(-6, 6))} ${f((y1 + y2) / 2 + rng.range(-6, 6))} ${f(x2)} ${f(y2)}" stroke="${graphite(rng)}" stroke-width="1.5" fill="none" opacity="0.8"/>`;
}
