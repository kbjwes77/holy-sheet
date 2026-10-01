// Reference sheet generator: test definition → one SVG per page, built only from LayoutSpec
// and the codec. The browser generator should produce the same geometry.
import QRCode from "qrcode";
import { pack, type PagePayload, FORMAT_VERSION } from "../src/codec.ts";
import {
    CHOICE_LETTERS,
    LAYOUT,
    type LayoutSpec,
    cellCenter,
    colX,
    markerRect,
    qrSymbolRect,
    rangeRect,
    ringCenters,
    ringRadius,
    rowY,
} from "../src/layout.ts";

export interface QuestionDef {
    prompt: string;
    /** Choice texts; their count is the ring count (1–8). */
    choices: string[];
}

export interface TestDef {
    title: string;
    questions: QuestionDef[];
}

export interface PlacedQuestion {
    index: number;
    /** First content row; content occupies [contentRow, ringRow). */
    contentRow: number;
    ringRow: number;
    promptLines: string[];
    choiceLines: string[];
}

export interface PageLayout {
    pageNumber: number;
    questions: PlacedQuestion[];
}

const FONT = "Arial, Helvetica, sans-serif";
const TEXT_SIZE = 11;
const MAX_CHARS = 112;

export function wrap(text: string, maxChars = MAX_CHARS): string[] {
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
        if (line && line.length + 1 + word.length > maxChars) {
            lines.push(line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) lines.push(line);
    return lines;
}

function choiceLines(q: QuestionDef): string[] {
    // Lay choices out several per line where they fit.
    const items = q.choices.map((c, i) => `${CHOICE_LETTERS[i]}) ${c}`);
    const lines: string[] = [];
    let line = "";
    for (const item of items) {
        const next = line ? `${line}     ${item}` : item;
        if (line && next.length > MAX_CHARS) {
            lines.push(line);
            line = item;
        } else line = next;
    }
    if (line) lines.push(line);
    return lines;
}

/** Assigns every question to a page and grid rows. */
export function paginate(test: TestDef, L: LayoutSpec = LAYOUT): PageLayout[] {
    const pages: PageLayout[] = [{ pageNumber: 1, questions: [] }];
    let row = L.bodyFirstRow;
    test.questions.forEach((q, index) => {
        if (q.choices.length < 1 || q.choices.length > L.ring.maxChoices) {
            throw new RangeError(`question ${index + 1} has ${q.choices.length} choices`);
        }
        const promptLines = wrap(`${index + 1}. ${q.prompt}`);
        const cLines = choiceLines(q);
        const contentRows = promptLines.length + cLines.length;
        if (contentRows + 1 > L.bodyLastRow - L.bodyFirstRow + 1) throw new RangeError(`question ${index + 1} is too long`);
        if (row + contentRows > L.bodyLastRow) {
            pages.push({ pageNumber: pages.length + 1, questions: [] });
            row = L.bodyFirstRow;
        }
        pages.at(-1)!.questions.push({ index, contentRow: row, ringRow: row + contentRows, promptLines, choiceLines: cLines });
        row += contentRows + 2; // ring row + one blank row
    });
    return pages;
}

export function payloadFor(test: TestDef, pages: PageLayout[], page: PageLayout): PagePayload {
    return {
        version: FORMAT_VERSION,
        totalPages: pages.length,
        pageNumber: page.pageNumber,
        totalQuestions: test.questions.length,
        questionsOnPage: page.questions.length,
        firstQuestionIndex: page.questions[0]?.index ?? 0,
        rows: page.questions.map((q) => q.ringRow),
    };
}

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const f = (n: number) => +n.toFixed(2);

export function qrSvg(bytes: Uint8Array, L: LayoutSpec = LAYOUT): string {
    const qr = QRCode.create([{ data: Buffer.from(bytes), mode: "byte" }], { errorCorrectionLevel: "M" });
    const n = qr.modules.size;
    const r = qrSymbolRect(L);
    const m = r.w / n;
    let d = "";
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            if (qr.modules.get(y, x)) d += `M${f(r.x + x * m)} ${f(r.y + y * m)}h${f(m)}v${f(m)}h${f(-m)}z`;
        }
    }
    return `<path d="${d}" fill="#000" shape-rendering="crispEdges"/>`;
}

export interface RenderOptions {
    /** Extra SVG (e.g. simulated pencil) appended on top of page `pageNumber`. */
    overlay?: (page: PageLayout) => string;
    layout?: LayoutSpec;
}

export interface RenderedPage {
    page: PageLayout;
    payload: PagePayload;
    svg: string;
}

export function renderTest(test: TestDef, opts: RenderOptions = {}): RenderedPage[] {
    const L = opts.layout ?? LAYOUT;
    const pages = paginate(test, L);
    return pages.map((page) => {
        const payload = payloadFor(test, pages, page);
        const parts: string[] = [];
        const text = (x: number, y: number, s: string, attrs = "") =>
            parts.push(`<text x="${f(x)}" y="${f(y)}" font-family="${FONT}" ${attrs}>${esc(s)}</text>`);

        // Corner squares
        for (const c of L.cornerSquares) {
            const r = rangeRect(c, L);
            parts.push(`<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" fill="#000"/>`);
        }
        // QR
        parts.push(qrSvg(pack(payload), L));

        // Fields (page 1 only)
        if (page.pageNumber === 1) {
            const box = (label: string, range: (typeof L.fields)["name"]) => {
                const r = rangeRect(range, L);
                text(r.x, r.y - 4, label, `font-size="9" fill="#444"`);
                parts.push(
                    `<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" fill="none" stroke="#666" stroke-width="1"/>`,
                );
            };
            box("Name (first and last)", L.fields.name);
            box("Period", L.fields.period);
            box("Test name", L.fields.testName);
            box("Date", L.fields.date);
        } else {
            text(colX(4, L), rowY(3, L), test.title, `font-size="16" font-weight="bold"`);
        }
        const divY = rowY(L.headerDividerRow, L) + L.cellH / 2;
        parts.push(`<line x1="${f(colX(4, L))}" y1="${f(divY)}" x2="${f(colX(L.qrArea.col1, L))}" y2="${f(divY)}" stroke="#000" stroke-width="1"/>`);
        text(colX(L.qrArea.col2 + 1, L), divY + 4, `Page ${page.pageNumber} of ${pages.length}`, `font-size="10" text-anchor="end"`);

        // Questions
        const rr = ringRadius(L);
        for (const q of page.questions) {
            let row = q.contentRow;
            const baseline = (r: number) => rowY(r, L) + L.cellH * 0.72;
            q.promptLines.forEach((line, i) =>
                text(colX(4, L), baseline(row++), line, `font-size="${TEXT_SIZE}"${i === 0 ? ` font-weight="bold"` : ""}`),
            );
            for (const line of q.choiceLines) text(colX(4, L) + 12, baseline(row++), line, `font-size="${TEXT_SIZE}" xml:space="preserve"`);

            const m = markerRect(q.ringRow, L);
            parts.push(`<rect x="${f(m.x)}" y="${f(m.y)}" width="${f(m.w)}" height="${f(m.h)}" fill="#000"/>`);
            const numAt = cellCenter(3, q.ringRow, L);
            text(numAt.x + L.cellW / 2 - 2, numAt.y + 4, String(q.index + 1), `font-size="10" text-anchor="end" fill="#333"`);
            const count = test.questions[q.index]!.choices.length;
            ringCenters(count, q.ringRow, L).forEach((c, i) => {
                parts.push(
                    `<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(rr)}" fill="none" stroke="#000" stroke-width="${L.ring.strokeWidth}"/>`,
                );
                text(c.x, c.y + 3, CHOICE_LETTERS[i]!, `font-size="8" text-anchor="middle" fill="#b4b4b4"`);
            });
        }

        if (opts.overlay) parts.push(opts.overlay(page));
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="${L.pageWidth}" height="${L.pageHeight}" viewBox="0 0 ${L.pageWidth} ${L.pageHeight}">` +
            `<rect width="100%" height="100%" fill="#fff"/>${parts.join("")}</svg>`;
        return { page, payload, svg };
    });
}
