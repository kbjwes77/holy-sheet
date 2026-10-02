// Reference sheet generator: test definition → one SVG per page, built only from LayoutSpec
// and the codec. The browser generator should produce the same geometry.
import QRCode from "qrcode";
import { pack, payloadByteLength, type PagePayload, FORMAT_VERSION } from "../src/codec.ts";
import {
    CHOICE_LETTERS,
    LAYOUT,
    type BubbleColumn,
    type LayoutSpec,
    bubbleCenter,
    colX,
    markerRect,
    qrSymbolRect,
    rangeRect,
    ringRadius,
    rowY,
    textRightEdge,
} from "../src/layout.ts";
import { renderFigure, type Figure } from "./figures.ts";
import { textWidth, truncate, wrapWidth } from "./textwidth.ts";

export interface QuestionDef {
    prompt: string;
    /** Choice texts, one bubble each (1–8). */
    choices: string[];
    /** Figures printed between the prompt and the choices, in order. */
    figures?: Figure[];
}

export interface TestDef {
    title: string;
    questions: QuestionDef[];
}

/** Where a question prints: across the page, or in one column of a two-column band. */
export type QuestionColumn = "full" | "left" | "right";

export interface PlacedChoice {
    /** Grid row of the choice's bubble and first text line; wrapped lines take the rows below. */
    row: number;
    lines: string[];
}

export interface PlacedFigure {
    figure: Figure;
    /** Top-left corner of the figure's box (drawing and caption), page units. */
    x: number;
    y: number;
}

export interface PlacedQuestion {
    index: number;
    column: QuestionColumn;
    /** First prompt row; the prompt occupies [promptRow, promptRow + promptLines.length). */
    promptRow: number;
    promptLines: string[];
    /** Figures fill whole rows between the prompt and the first choice, or sit beside them (see `placeBeside`). */
    figures: PlacedFigure[];
    /** One per choice, A first, each starting on its own bubble row. */
    choices: PlacedChoice[];
}

/** The hairline between a band's columns, over grid rows [fromRow, toRow). */
export interface ColumnDivider {
    fromRow: number;
    toRow: number;
}

export interface PageLayout {
    pageNumber: number;
    questions: PlacedQuestion[];
    dividers: ColumnDivider[];
    /**
     * Grid rows whose top edge carries a hairline across the page, where full-width questions
     * follow a two-column band (at most one per page). It has a blank row above and below it.
     */
    sectionBreaks: number[];
}

const FONT = "Arial, Helvetica, sans-serif";
const TEXT_SIZE = 11;
/** Width of the "A)" label column; choice text starts after it. */
const CHOICE_LABEL_W = 16;
/** Gap between the bubble's column and the choice label, in page units. */
const CHOICE_LABEL_GAP = 4;
const FOOTER_SIZE = 8;
/** The test name prints on one line at this size when it fits. */
const TITLE_SIZE = 16;
/** A name that wraps shrinks from this size, down to the minimum, until it fits two lines. */
const TITLE_WRAP_SIZE = 14;
const TITLE_MIN_SIZE = 10;
const TITLE_LEADING = 1.2;
const PAGE_LABEL_SIZE = 9;
/** Question numbers print in light text on a dark grey rectangle, left of the prompt. */
const NUMBER_SIZE = 12;
const NUMBER_PAD = 5;
const NUMBER_H = 15;
/** Space between the number's rectangle and the prompt text; every prompt line starts after it. */
const NUMBER_GAP = 5;
/** The prompt's first line sits on a light grey rectangle, running on from the number's to just past the text. */
const PROMPT_BAR_FILL = "#eeeeee";
const PROMPT_BAR_PAD = 4;
export const INSTRUCTIONS = "Fill in the bubble next to every correct answer. Some questions may have more than one correct answer.";

/** Gap between figures side by side, and the space above and below a line of figures. */
const FIGURE_GAP = 15;
const FIGURE_PAD = 4;

/**
 * The most payload a page may carry: what fits a version 2 QR code at level M in byte mode. A
 * bigger payload needs a denser symbol with smaller modules in the same square, so a page that
 * would need one closes early instead (at 14 questions when it has two columns).
 */
export const MAX_PAYLOAD_BYTES = 26;

/** The widest a figure can print: the full text column, from the prompt's left edge. */
export function figureMaxWidth(L: LayoutSpec = LAYOUT): number {
    return textRightEdge(L.qrClearRow, L) - colX(L.promptCol, L);
}

/** The bubble column a question's bubbles are in. */
export function bubbleColumnOf(column: QuestionColumn): BubbleColumn {
    return column === "right" ? 1 : 0;
}

interface ColumnGeometry {
    promptX: number;
    ringCol: number;
    /** Right edge of text on grid row `row`. */
    right(row: number): number;
    /** The column's first usable row. */
    firstRow: number;
}

function geometry(column: QuestionColumn, L: LayoutSpec): ColumnGeometry {
    if (column === "right") {
        const c = L.columns.right;
        return { promptX: colX(c.promptCol, L), ringCol: c.ringCol, right: (r) => textRightEdge(r, L), firstRow: L.qrClearRow };
    }
    const leftEdge = colX(L.columns.leftLastCol + 1, L);
    return {
        promptX: colX(L.promptCol, L),
        ringCol: L.ring.col,
        right: column === "left" ? () => leftEdge : (r) => textRightEdge(r, L),
        firstRow: 1,
    };
}

/** Left edge of a choice's "A)" label for a question in `column`. */
function choiceLabelX(column: QuestionColumn, L: LayoutSpec): number {
    return colX(geometry(column, L).ringCol + 1, L) + CHOICE_LABEL_GAP;
}

/** Width of question `index`'s number rectangle: one- and two-digit numbers share a width. */
function numberWidth(index: number): number {
    return Math.max(textWidth(String(index + 1), NUMBER_SIZE, true), textWidth("00", NUMBER_SIZE, true)) + 2 * NUMBER_PAD;
}

/** Where question `index`'s prompt text starts, right of its number. */
function promptIndent(index: number): number {
    return numberWidth(index) + NUMBER_GAP;
}

/** A question that doesn't fit on a page even when it starts one. */
export class QuestionTooLongError extends RangeError {
    override name = "QuestionTooLongError";
    constructor(
        /** 0-based question index. */
        readonly index: number,
        /** Rows its figures take. */
        readonly figureRows: number,
    ) {
        super(`question ${index + 1} is too long`);
    }
}

/**
 * Lays figures out from row `row` in lines, left to right, wrapping when the next one doesn't fit.
 * A line beside the QR has less room; if its first figure doesn't fit there, the line moves down
 * to the first full-width row. Returns the figures and the row after the last line, or null when
 * a figure is wider than the column.
 */
function placeFigures(figs: Figure[], row: number, g: ColumnGeometry, L: LayoutSpec): { placed: PlacedFigure[]; end: number } | null {
    const left = g.promptX;
    if (figs.some((fig) => fig.boxW > g.right(L.qrClearRow) - left + 0.5)) return null;
    const placed: PlacedFigure[] = [];
    let i = 0;
    while (i < figs.length) {
        if (row < L.qrClearRow && figs[i]!.boxW > g.right(row) - left) {
            row = L.qrClearRow;
            continue;
        }
        const right = g.right(row);
        const top = rowY(row, L) + FIGURE_PAD;
        let x = left;
        let height = 0;
        do {
            const fig = figs[i]!;
            placed.push({ figure: fig, x, y: top });
            x += fig.boxW + FIGURE_GAP;
            height = Math.max(height, fig.boxH);
            i++;
        } while (i < figs.length && x + figs[i]!.boxW <= right);
        row += Math.ceil((height + 2 * FIGURE_PAD) / L.cellH);
    }
    return { placed, end: row };
}

interface Placement {
    placed: PlacedQuestion;
    /** The row after the question's last line. */
    end: number;
}

/**
 * Lays question `index` out in `column` from grid row `row` (or the column's first row, if
 * lower): its prompt lines, then each choice's lines (one bubble row each). Line widths depend
 * on the row each line lands on, since rows beside the QR are narrower. Null when its figures
 * are too wide for the column.
 */
function placeStacked(q: QuestionDef, index: number, column: QuestionColumn, row: number, L: LayoutSpec): Placement | null {
    const g = geometry(column, L);
    row = Math.max(row, g.firstRow);
    const indent = promptIndent(index);
    const promptLines = wrapWidth(q.prompt, (i) => g.right(row + i) - g.promptX - indent, TEXT_SIZE, true);
    const figs = placeFigures(q.figures ?? [], row + promptLines.length, g, L);
    if (!figs) return null;
    const placed: PlacedQuestion = { index, column, promptRow: row, promptLines, figures: figs.placed, choices: [] };
    let at = figs.end;
    const textX = choiceLabelX(column, L) + CHOICE_LABEL_W;
    for (const c of q.choices) {
        const start = at;
        const lines = wrapWidth(c, (i) => g.right(start + i) - textX, TEXT_SIZE);
        placed.choices.push({ row: start, lines });
        at += lines.length;
    }
    return { placed, end: at };
}

/** Space between a question's text and the figures beside it. */
const BESIDE_GAP = 2 * FIGURE_GAP;

/**
 * Lays full-width question `index` out with its figures beside its text instead of between the
 * prompt and the choices: the figures flush right, in lines no wider than a column, and the prompt
 * and choices in the width left of them (the full width again below them). The figures start
 * level with the prompt, or at the first full-width row when the rows beside the QR are taken.
 * Null when it has no figures, one is wider than a column, or a choice would wrap.
 */
function placeBeside(q: QuestionDef, index: number, row: number, L: LayoutSpec): Placement | null {
    const figs = q.figures ?? [];
    const colW = textRightEdge(L.qrClearRow, L) - colX(L.columns.right.promptCol, L);
    if (!figs.length || figs.some((fig) => fig.boxW > colW + 0.5)) return null;
    const lines: { figs: Figure[]; rows: number }[] = [];
    let width = 0;
    for (let i = 0; i < figs.length; ) {
        const line: Figure[] = [];
        let w = -FIGURE_GAP;
        let h = 0;
        do {
            line.push(figs[i]!);
            w += FIGURE_GAP + figs[i]!.boxW;
            h = Math.max(h, figs[i]!.boxH);
            i++;
        } while (i < figs.length && w + FIGURE_GAP + figs[i]!.boxW <= colW);
        lines.push({ figs: line, rows: Math.ceil((h + 2 * FIGURE_PAD) / L.cellH) });
        width = Math.max(width, w);
    }
    const figRows = lines.reduce((n, l) => n + l.rows, 0);
    const promptX = colX(L.promptCol, L) + promptIndent(index);
    const textX = choiceLabelX("full", L) + CHOICE_LABEL_W;
    let best: Placement | null = null;
    for (const top of row < L.qrClearRow ? [row, L.qrClearRow] : [row]) {
        const end = top + figRows;
        const figLeft = textRightEdge(top, L) - width;
        const right = (r: number) => (r >= top && r < end ? Math.min(textRightEdge(r, L), figLeft - BESIDE_GAP) : textRightEdge(r, L));
        const promptLines = wrapWidth(q.prompt, (i) => right(row + i) - promptX, TEXT_SIZE, true);
        const placed: PlacedQuestion = { index, column: "full", promptRow: row, promptLines, figures: [], choices: [] };
        let at = row + promptLines.length;
        let wraps = false;
        for (const c of q.choices) {
            const start = at;
            const choiceLines = wrapWidth(c, (i) => right(start + i) - textX, TEXT_SIZE);
            wraps ||= choiceLines.length > 1;
            placed.choices.push({ row: start, lines: choiceLines });
            at += choiceLines.length;
        }
        if (wraps) continue;
        let r = top;
        for (const line of lines) {
            let x = figLeft;
            for (const fig of line.figs) {
                placed.figures.push({ figure: fig, x, y: rowY(r, L) + FIGURE_PAD });
                x += fig.boxW + FIGURE_GAP;
            }
            r += line.rows;
        }
        const qEnd = Math.max(at, end);
        if (!best || qEnd < best.end) best = { placed, end: qEnd };
    }
    return best;
}

/**
 * Lays question `index` out in `column` from `row`. A full-width question with figures that each
 * fit a column prints them beside its text when that ends on an earlier row than stacking them.
 */
function place(q: QuestionDef, index: number, column: QuestionColumn, row: number, L: LayoutSpec): Placement | null {
    const stacked = placeStacked(q, index, column, row, L);
    if (column !== "full") return stacked;
    const beside = placeBeside(q, index, row, L);
    return beside && (!stacked || beside.end < stacked.end) ? beside : stacked;
}

/** Packs one page at a time; caches placements, which pagination asks for many times over. */
class Packer {
    private readonly placements = new Map<string, Placement | null>();
    private readonly narrow = new Map<number, boolean>();

    constructor(
        private readonly test: TestDef,
        private readonly L: LayoutSpec,
    ) {}

    place(index: number, column: QuestionColumn, row: number): Placement | null {
        const key = `${index}|${column}|${row}`;
        let p = this.placements.get(key);
        if (p === undefined) this.placements.set(key, (p = place(this.test.questions[index]!, index, column, row, this.L)));
        return p;
    }

    /** Whether a question prints in a column: its figures fit one and none of its choices wrap there. */
    fitsColumn(index: number): boolean {
        let n = this.narrow.get(index);
        if (n === undefined) {
            const p = this.place(index, "left", this.L.qrClearRow);
            this.narrow.set(index, (n = !!p && p.placed.choices.every((c) => c.lines.length === 1)));
        }
        return n;
    }

    /**
     * Question `index` in `column`, starting on a row from `top` to `firstBubble` with no choice
     * above `firstBubble`: on later pages, the first question's prompt rises beside the corner
     * square so its first choice can land on the first bubble row. Of the starts that end it
     * earliest, the lowest, so a figure that has to drop below the QR stays near its prompt.
     */
    private placeTop(index: number, column: QuestionColumn, top: number, firstBubble: number): Placement | null {
        let best: Placement | null = null;
        for (let row = top; row <= firstBubble; row++) {
            const p = this.place(index, column, row);
            if (!p) return null;
            if (p.placed.choices[0]!.row >= firstBubble && (!best || p.end <= best.end)) best = p;
        }
        return best;
    }

    /**
     * Questions `ids` one under another in `column` from `row`, a blank row between them. The
     * first may start above `firstBubble` (see `placeTop`), if given.
     */
    private stack(ids: number[], column: QuestionColumn, row: number, firstBubble = row): { placed: PlacedQuestion[]; end: number } | null {
        const placed: PlacedQuestion[] = [];
        for (const [n, i] of ids.entries()) {
            const p = n ? this.place(i, column, row + 1) : this.placeTop(i, column, row, firstBubble);
            if (!p) return null;
            placed.push(p.placed);
            row = p.end;
        }
        return { placed, end: row };
    }

    /**
     * Lays out questions `ids` on one page from row `start.top`, its first bubble no higher than
     * `start.firstBubble`, or returns null if they don't fit.
     * Questions go in two columns where they fit one (see `fitsColumn`). Full-width questions,
     * and a column question with no other beside it, print across the page. A page has at most
     * one two-column band: full-width questions above it, then the band, then, once a full-width
     * question follows the band, every remaining question full width. A section break (blank
     * row, hairline, blank row) separates the band from full-width questions below it; those
     * above it need only the usual blank row.
     * The columns split where they come out closest in height, any extra question going left.
     */
    layoutPage(ids: number[], start: { top: number; firstBubble: number }): Omit<PageLayout, "pageNumber"> | null {
        const L = this.L;
        const runs: { ids: number[]; narrow: boolean }[] = [];
        for (const i of ids) {
            const narrow = this.fitsColumn(i);
            const last = runs.at(-1);
            if (narrow && last?.narrow) last.ids.push(i);
            else runs.push({ ids: [i], narrow });
        }
        const questions: PlacedQuestion[] = [];
        const dividers: ColumnDivider[] = [];
        const sectionBreaks: number[] = [];
        let row = start.top;
        for (const [n, run] of runs.entries()) {
            // Only the page's first question can start above its first bubble row.
            const firstBubble = n ? undefined : start.firstBubble;
            if (n > 0) row++; // blank row between questions
            const band = run.narrow && run.ids.length > 1;
            // Full width after the band: a hairline on this blank row's bottom edge, then another blank row.
            if (dividers.length) sectionBreaks.push(row++);
            if (!band) {
                // Below the band, everything left prints full width.
                const rest = dividers.length ? runs.slice(n).flatMap((r) => r.ids) : run.ids;
                const full = this.stack(rest, "full", row, firstBubble);
                if (!full) return null;
                questions.push(...full.placed);
                row = full.end;
                if (dividers.length) break;
                continue;
            }
            let best: { left: PlacedQuestion[]; right: PlacedQuestion[]; end: number } | null = null;
            for (let t = 1; t < run.ids.length; t++) {
                const left = this.stack(run.ids.slice(0, t), "left", row, firstBubble);
                const right = this.stack(run.ids.slice(t), "right", row);
                if (!left || !right) continue;
                const end = Math.max(left.end, right.end);
                if (!best || end <= best.end) best = { left: left.placed, right: right.placed, end };
            }
            if (!best) return null;
            questions.push(...best.left, ...best.right);
            dividers.push({ fromRow: Math.max(row, L.qrClearRow), toRow: best.end });
            row = best.end;
        }
        if (row - 1 > L.bodyLastRow) return null;
        if (payloadByteLength(questions.length, dividers.length > 0) > MAX_PAYLOAD_BYTES) return null;
        return { questions, dividers, sectionBreaks };
    }
}

/**
 * Assigns every question to a page, in order, filling each page before starting the next. Page 1
 * starts a blank row below the header. Later pages start with the first choice on row 4, the
 * prompt above it beside the corner square. A question that fits no page throws QuestionTooLongError.
 */
export function paginate(test: TestDef, L: LayoutSpec = LAYOUT): PageLayout[] {
    test.questions.forEach((q, index) => {
        if (q.choices.length < 1 || q.choices.length > L.ring.maxChoices) {
            throw new RangeError(`question ${index + 1} has ${q.choices.length} choices`);
        }
    });
    const packer = new Packer(test, L);
    const pages: PageLayout[] = [];
    const startOf = (pageNumber: number) =>
        pageNumber === 1 ? { top: L.firstRowPage1, firstBubble: L.firstRowPage1 } : { top: L.topRowContinued, firstBubble: L.firstRowContinued };
    let ids: number[] = [];
    let current: Omit<PageLayout, "pageNumber"> = { questions: [], dividers: [], sectionBreaks: [] };
    test.questions.forEach((_, index) => {
        const next = packer.layoutPage([...ids, index], startOf(pages.length + 1));
        if (next) {
            ids.push(index);
            current = next;
            return;
        }
        pages.push({ pageNumber: pages.length + 1, ...current });
        ids = [index];
        const fresh = packer.layoutPage(ids, startOf(pages.length + 1));
        if (!fresh) {
            const p = placeStacked(test.questions[index]!, index, "full", L.firstRowContinued, L)!.placed;
            throw new QuestionTooLongError(index, p.choices[0]!.row - p.promptRow - p.promptLines.length);
        }
        current = fresh;
    });
    pages.push({ pageNumber: pages.length + 1, ...current });
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
        choiceRows: page.questions.map((q) => q.choices.map((c) => c.row)),
        columns: page.questions.map((q) => bubbleColumnOf(q.column)),
    };
}

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const f = (n: number) => +n.toFixed(2);

export function qrSvg(bytes: Uint8Array, L: LayoutSpec = LAYOUT): string {
    // A plain Uint8Array (not Buffer) keeps this usable in the browser bundle.
    const qr = QRCode.create([{ data: bytes as unknown as Buffer, mode: "byte" }], { errorCorrectionLevel: "M" });
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

/**
 * The test name's lines and font size in a title area `width` wide: one line at `TITLE_SIZE` when
 * it fits, else two lines at the largest size from `TITLE_WRAP_SIZE` down to `TITLE_MIN_SIZE` that
 * holds it, else two lines at the minimum with the second truncated by "…".
 */
export function titleLayout(title: string, width: number): { lines: string[]; size: number } {
    const one = wrapWidth(title, width, TITLE_SIZE, true);
    if (one.length <= 1) return { lines: one, size: TITLE_SIZE };
    for (let size = TITLE_WRAP_SIZE; size >= TITLE_MIN_SIZE; size -= 0.5) {
        const lines = wrapWidth(title, width, size, true);
        if (lines.length <= 2) return { lines, size };
    }
    const lines = wrapWidth(title, width, TITLE_MIN_SIZE, true);
    return { lines: [lines[0]!, truncate(lines.slice(1).join(" "), width, TITLE_MIN_SIZE, true)], size: TITLE_MIN_SIZE };
}

export function renderTest(test: TestDef, opts: RenderOptions = {}): RenderedPage[] {
    const L = opts.layout ?? LAYOUT;
    const pages = paginate(test, L);
    return pages.map((page) => {
        const payload = payloadFor(test, pages, page);
        const parts: string[] = [];
        const text = (x: number, y: number, s: string, attrs = "") =>
            parts.push(`<text x="${f(x)}" y="${f(y)}" font-family="${FONT}" ${attrs}>${esc(s)}</text>`);
        const baseline = (r: number) => rowY(r, L) + L.cellH * 0.72;

        // Corner squares
        for (const c of L.cornerSquares) {
            const r = rangeRect(c, L);
            parts.push(`<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" fill="#000"/>`);
        }
        // QR
        parts.push(qrSvg(pack(payload), L));

        // Page 1 header: the test name, bottom-aligned in the title area, the handwritten fields
        // side by side under it, then the marking instructions. Later pages use that space for
        // questions.
        if (page.pageNumber === 1) {
            const ta = rangeRect(L.titleArea, L);
            const title = titleLayout(test.title, ta.w);
            title.lines.forEach((line, i) =>
                text(ta.x, ta.y + ta.h - 3 - (title.lines.length - 1 - i) * title.size * TITLE_LEADING, line, `font-size="${title.size}" font-weight="bold"`),
            );

            const box = (label: string, range: (typeof L.fields)["name"]) => {
                const r = rangeRect(range, L);
                text(r.x, r.y - 4, label, `font-size="9" fill="#444"`);
                parts.push(
                    `<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" fill="none" stroke="#666" stroke-width="1"/>`,
                );
            };
            box("Name (first and last)", L.fields.name);
            box("Period", L.fields.period);
            box("Date", L.fields.date);
            text(colX(L.promptCol, L), baseline(L.instructionsRow) + 1, INSTRUCTIONS, `font-size="10" font-style="italic" fill="#333"`);
        }
        // Footer, between the bottom corner squares: the full test name centred, and "Page X of
        // Y" right-aligned. The name stays clear of the label on both sides, so it stays centred.
        const footL = colX(L.cornerSquares[3].col2 + 2, L);
        const footR = colX(L.cornerSquares[2].col1 - 1, L);
        const footY = rowY(L.rows, L) + 3;
        const label = `Page ${page.pageNumber} of ${pages.length}`;
        const labelRoom = textWidth(label, PAGE_LABEL_SIZE) + 12;
        text(
            (footL + footR) / 2,
            footY,
            truncate(test.title, footR - footL - 2 * labelRoom, FOOTER_SIZE),
            `font-size="${FOOTER_SIZE}" text-anchor="middle" fill="#555"`,
        );
        text(footR, footY, label, `font-size="${PAGE_LABEL_SIZE}" text-anchor="end"`);

        // A hairline between the columns of each two-column band.
        const dividerX = colX(L.columns.dividerCol, L) + L.cellW / 2;
        for (const d of page.dividers) {
            parts.push(`<line x1="${f(dividerX)}" y1="${f(rowY(d.fromRow, L))}" x2="${f(dividerX)}" y2="${f(rowY(d.toRow, L))}" stroke="#999" stroke-width="0.6"/>`);
        }
        // A hairline across the text area where full-width questions follow the band, short of the QR beside it.
        for (const r of page.sectionBreaks) {
            const y = f(rowY(r, L));
            const x2 = Math.min(textRightEdge(r - 1, L), textRightEdge(r, L));
            parts.push(`<line x1="${f(colX(L.promptCol, L))}" y1="${y}" x2="${f(x2)}" y2="${y}" stroke="#999" stroke-width="0.6"/>`);
        }

        // Questions: the number in light text on a dark grey rectangle, the bold prompt beside it
        // (its first line on a light grey one), then each choice on its own row with a bubble. Every bubble row
        // gets one timing marker in the marker column, whichever column its bubbles are in.
        const rr = ringRadius(L);
        const markerRows = new Set<number>();
        let figureCount = 0;
        for (const q of page.questions) {
            const g = geometry(q.column, L);
            const nw = numberWidth(q.index);
            const mid = rowY(q.promptRow, L) + L.cellH / 2;
            const px = g.promptX + promptIndent(q.index);
            const barR = px + textWidth(q.promptLines[0] ?? "", TEXT_SIZE, true) + PROMPT_BAR_PAD;
            parts.push(
                `<rect x="${f(g.promptX + nw)}" y="${f(mid - NUMBER_H / 2)}" width="${f(barR - g.promptX - nw)}" height="${NUMBER_H}" fill="${PROMPT_BAR_FILL}"/>`,
            );
            parts.push(`<rect x="${f(g.promptX)}" y="${f(mid - NUMBER_H / 2)}" width="${f(nw)}" height="${NUMBER_H}" fill="#222222"/>`);
            // Arial's digits are 0.716 em tall; this centres them in the rectangle.
            text(g.promptX + nw / 2, mid + 0.358 * NUMBER_SIZE, String(q.index + 1), `font-size="${NUMBER_SIZE}" font-weight="900" text-anchor="middle" fill="#FFFFFF"`);
            q.promptLines.forEach((line, i) => text(px, baseline(q.promptRow + i), line, `font-size="${TEXT_SIZE}" font-weight="bold"`));
            // A figure can appear twice on a page (shared by two questions), so ids get a per-placement prefix.
            for (const pf of q.figures) parts.push(renderFigure(pf.figure, pf.x, pf.y, `p${page.pageNumber}f${++figureCount}-`));
            const x = choiceLabelX(q.column, L);
            q.choices.forEach((c, i) => {
                markerRows.add(c.row);
                const b = bubbleCenter(c.row, bubbleColumnOf(q.column), L);
                parts.push(`<circle cx="${f(b.x)}" cy="${f(b.y)}" r="${f(rr)}" fill="none" stroke="#000" stroke-width="${L.ring.strokeWidth}"/>`);
                text(x, baseline(c.row), `${CHOICE_LETTERS[i]})`, `font-size="${TEXT_SIZE}" font-weight="bold"`);
                c.lines.forEach((line, k) => text(x + CHOICE_LABEL_W, baseline(c.row + k), line, `font-size="${TEXT_SIZE}"`));
            });
        }
        for (const row of markerRows) {
            const m = markerRect(row, L);
            parts.push(`<rect x="${f(m.x)}" y="${f(m.y)}" width="${f(m.w)}" height="${f(m.h)}" fill="#000"/>`);
        }

        if (opts.overlay) parts.push(opts.overlay(page));
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${L.pageWidth}" height="${L.pageHeight}" viewBox="0 0 ${L.pageWidth} ${L.pageHeight}">` +
            `<rect width="100%" height="100%" fill="#fff"/>${parts.join("")}</svg>`;
        return { page, payload, svg };
    });
}
