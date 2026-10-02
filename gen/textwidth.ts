// Text measurement with Helvetica (≈ Arial) advance widths, so wrapping and truncation are the
// same in Bun, the browser preview and the PDF (where svg2pdf maps Arial to Helvetica).

// Widths per 1000 em for ASCII 32–126 (Adobe Helvetica AFM).
const ASCII = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
    556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
    260, 334, 584,
];
const BOLD_SCALE = 1.08;

export function textWidth(s: string, fontSize: number, bold = false): number {
    let w = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0)!;
        w += c >= 32 && c <= 126 ? ASCII[c - 32]! : c === 0x2026 ? 1000 : 556;
    }
    return (w / 1000) * fontSize * (bold ? BOLD_SCALE : 1);
}

/**
 * Word-wraps `text` to lines no wider than `maxWidth`; a single over-long word is hard-broken.
 * `maxWidth` may vary by line: it's then called with each line's 0-based index.
 */
export function wrapWidth(text: string, maxWidth: number | ((line: number) => number), fontSize: number, bold = false): string[] {
    const lines: string[] = [];
    let line = "";
    const width = typeof maxWidth === "number" ? () => maxWidth : maxWidth;
    const fits = (s: string) => textWidth(s, fontSize, bold) <= width(lines.length);
    for (let word of text.split(/\s+/).filter(Boolean)) {
        const joined = line ? `${line} ${word}` : word;
        if (fits(joined)) {
            line = joined;
            continue;
        }
        if (line) lines.push(line);
        while (!fits(word)) {
            let n = word.length - 1;
            while (n > 1 && !fits(word.slice(0, n))) n--;
            lines.push(word.slice(0, n));
            word = word.slice(n);
        }
        line = word;
    }
    if (line) lines.push(line);
    return lines;
}

/** Returns `text`, or the longest prefix + "…" that fits in `maxWidth`. */
export function truncate(text: string, maxWidth: number, fontSize: number, bold = false): string {
    const t = text.trim().replace(/\s+/g, " ");
    if (textWidth(t, fontSize, bold) <= maxWidth) return t;
    const chars = [...t];
    let n = chars.length;
    while (n > 0 && textWidth(chars.slice(0, n).join("").trimEnd() + "…", fontSize, bold) > maxWidth) n--;
    return chars.slice(0, n).join("").trimEnd() + "…";
}

// Characters a standard PDF font (WinAnsi) can draw, beyond printable ASCII and Latin-1.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Whether the sheet's fonts (and the PDF's standard fonts) can print `ch`. */
export function printable(ch: string): boolean {
    const c = ch.codePointAt(0)!;
    return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || c === 9 || c === 10 || c === 13 || WIN_ANSI_EXTRA.has(ch);
}

/** Lists the characters in `s` that can't be printed, e.g. `"→" (U+2192)`; empty if none. */
export function unprintable(s: string): string {
    const bad = [...new Set([...s].filter((ch) => !printable(ch)))];
    return bad
        .slice(0, 5)
        .map((ch) => `"${ch}" (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`)
        .join(", ");
}
