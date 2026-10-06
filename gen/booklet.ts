// Separate answer sheet mode: the questions print on plain pages (no QR, markers or fields, never
// scanned), packed in two newspaper columns, then every answer goes on an answer sheet at the
// end: one row of side-by-side bubbles per question, in blocks across the page, and a full-width
// writing box per free-response question, in test order between them. Only the answer sheet is
// scanned; its QR carries a version 5 payload, or version 7 with boxes (see codec.ts).
import {
    ANSWER_FIRST_ROW,
    ANSWER_FORMAT_VERSION,
    ANSWER_LAST_ROW,
    ANSWER_MAX_ROWS,
    FREE_ANSWER_FORMAT_VERSION,
    MAX_PAGES,
    answerPayloadByteLength,
    answerRow,
    pack,
    type AnswerGridSpec,
    type PagePayload,
} from "../src/codec.ts";
import { CHOICE_LETTERS, LAYOUT, ROWS_PER_LINE, type LayoutSpec, type Point, answerBubbleCenter, answerGridGeometry, answerRingRadius, colX, rowY } from "../src/layout.ts";
import { renderFigure, type Figure } from "./figures.ts";
import {
    INSTRUCTIONS_ATTRS,
    QuestionTooLongError,
    TEXT_SIZE,
    cornerSquaresSvg,
    f,
    fieldsSvg,
    footerSvg,
    instructionsBaseline,
    markersSvg,
    numberBadge,
    isFree,
    pageSvg,
    promptIndent,
    qrSvg,
    responseBoxSvg,
    svgText,
    titleSvg,
    type TestDef,
} from "./sheet.ts";
import { textWidth, wrapWidth } from "./textwidth.ts";

/** Text lines on the question pages are this far apart; the first line of a prompt a little more, for its number. */
const LEAD = 14;
const FIRST_LINE = 17;
/** Space after a question's last line. */
const QUESTION_GAP = 12;
/** Space between the columns, with a hairline in the middle. */
const COLUMN_GAP = 26;
/** Width of a choice's "A." label; its text starts after it. */
const CHOICE_LABEL_W = 16;
/** The least space after a choice that shares its line with others. */
const CHOICE_SPACING = 14;
const FIGURE_GAP = 15;
const FIGURE_PAD = 4;
const BOOKLET_INSTRUCTIONS = "Mark your answers on the answer sheet at the end of this test.";
export const ANSWER_INSTRUCTIONS = "Fill in the bubble for every correct answer. Some questions may have more than one correct answer.";
/** Under a free-response question on a question page. */
export const freeResponseNote = (index: number) => `Write your answer in box ${index + 1} on the answer sheet.`;
/** Beside a box's number on the answer sheet. */
const BOX_LABEL = "Write your answer inside the box.";
/** An answer sheet's question numbers, and the letters printed faintly inside its bubbles. */
const ANSWER_NUMBER_SIZE = 10;
const ANSWER_LETTER_SIZE = 7.5;
const ANSWER_LETTER_FILL = "#a6a6a6";
/** Every other group of five answer rows sits on a light band, to help keep the place. */
const BAND_ROWS = 5;
const BAND_FILL = "#eeeeee";
const BAND_PAD = 4;

/**
 * The most payload an answer sheet page may carry: what fits a version 3 QR code at level M in
 * byte mode. Runs of equal choice counts keep a usual test far below it; a page whose questions'
 * choice counts vary a lot closes early instead (at 95 questions) rather than shrink the modules.
 */
export const MAX_ANSWER_PAYLOAD_BYTES = 42;

// ---- Question pages ----------------------------------------------------------

/** The question pages' text area: the same left and right edges as the scanned sheets' text. */
function bookletArea(L: LayoutSpec) {
    const left = colX(L.promptCol, L);
    const right = colX(L.cornerSquares[1].col1, L);
    const colW = (right - left - COLUMN_GAP) / 2;
    return {
        colW,
        colX: (c: number) => left + c * (colW + COLUMN_GAP),
        dividerX: left + colW + COLUMN_GAP / 2,
        /** Page 1 starts under the title and the instructions line. */
        top: (pageNumber: number) => (pageNumber === 1 ? rowY(5, L) + 2 : rowY(2, L)),
        bottom: rowY(L.bodyLastRow + 1, L),
    };
}

export interface PlacedFigureBox {
    figure: Figure;
    /** Offsets from the question's top-left corner, page units. */
    dx: number;
    dy: number;
    scale: number;
}

export interface ChoiceCell {
    /** Offsets from the question's top-left corner of the label's left edge and the first baseline. */
    dx: number;
    dy: number;
    lines: string[];
}

export interface BookletQuestion {
    index: number;
    promptLines: string[];
    figures: PlacedFigureBox[];
    choices: ChoiceCell[];
    /** A free-response question's pointer to its box on the answer sheet, offset like a choice. */
    note?: ChoiceCell;
    /** Choices per line: all on one line, a few per line, or 1 (stacked, wrapping under their text). */
    perLine: number;
    /** From the question's top to the next question's top. */
    height: number;
}

/** Lays question `index` out for a column `width` wide, from its top-left corner. */
export function measureQuestion(q: TestDef["questions"][number], index: number, width: number): BookletQuestion {
    const indent = promptIndent(index);
    const textW = width - indent;
    const promptLines = wrapWidth(q.prompt, textW, TEXT_SIZE, true);
    // First baseline: the first line's middle, plus half of Arial's cap height.
    let y = FIRST_LINE / 2 + 0.358 * TEXT_SIZE;
    y += (promptLines.length - 1) * LEAD;
    let bottom = y + 4;

    // Figures under the prompt, in lines from the prompt text's left edge. One too wide for that
    // gets a line of its own from the column's left edge, shrunk to the column if it's wider still.
    const figures: PlacedFigureBox[] = [];
    const figs = q.figures ?? [];
    let top = bottom + FIGURE_PAD;
    for (let i = 0; i < figs.length; ) {
        let h = 0;
        if (figs[i]!.boxW > textW) {
            const fig = figs[i++]!;
            const scale = Math.min(1, width / fig.boxW);
            figures.push({ figure: fig, dx: 0, dy: top, scale });
            h = fig.boxH * scale;
        } else {
            let x = indent;
            do {
                const fig = figs[i]!;
                figures.push({ figure: fig, dx: x, dy: top, scale: 1 });
                x += fig.boxW + FIGURE_GAP;
                h = Math.max(h, fig.boxH);
                i++;
            } while (i < figs.length && x + figs[i]!.boxW <= width);
        }
        top += h + FIGURE_PAD;
        bottom = top;
    }
    if (figs.length) y = bottom + FIGURE_PAD - 4;

    if (isFree(q)) {
        y += LEAD;
        const note = { dx: indent, dy: y, lines: wrapWidth(freeResponseNote(index), textW, TEXT_SIZE) };
        y += (note.lines.length - 1) * LEAD;
        return { index, promptLines, figures, choices: [], note, perLine: 1, height: y + 4 + QUESTION_GAP };
    }

    // Choices: as many to a line as fit in equal cells (all on one, or in a grid read across), else one per line, wrapped.
    const n = q.choices.length;
    const widths = q.choices.map((c) => CHOICE_LABEL_W + textWidth(c, TEXT_SIZE));
    let perLine = 1;
    for (let rows = 1; rows < n; rows++) {
        const m = Math.ceil(n / rows);
        if (m < 2) break;
        const cell = textW / m;
        if (widths.every((w) => w + CHOICE_SPACING <= cell)) {
            perLine = m;
            break;
        }
    }
    const choices: ChoiceCell[] = [];
    if (perLine > 1) {
        const cell = textW / perLine;
        q.choices.forEach((c, i) => {
            if (i % perLine === 0) y += LEAD;
            choices.push({ dx: indent + (i % perLine) * cell, dy: y, lines: [c] });
        });
    } else {
        for (const c of q.choices) {
            y += LEAD;
            const lines = wrapWidth(c, textW - CHOICE_LABEL_W, TEXT_SIZE);
            choices.push({ dx: indent, dy: y, lines });
            y += (lines.length - 1) * LEAD;
        }
    }
    // The last baseline, plus descenders, then the gap.
    return { index, promptLines, figures, choices, perLine, height: y + 4 + QUESTION_GAP };
}

export interface BookletPage {
    pageNumber: number;
    /** The left column's questions, then the right's, each with its top edge. */
    columns: { question: BookletQuestion; y: number }[][];
}

/**
 * Fills the question pages: down the left column, then the right, then the next page; a question
 * never splits. One taller than a whole column throws QuestionTooLongError.
 */
export function layoutBooklet(test: TestDef, L: LayoutSpec = LAYOUT): BookletPage[] {
    const area = bookletArea(L);
    const pages: BookletPage[] = [{ pageNumber: 1, columns: [[], []] }];
    let col = 0;
    let y = area.top(1);
    const full = area.bottom - area.top(2);
    test.questions.forEach((q, index) => {
        const m = measureQuestion(q, index, area.colW);
        // The gap below the question needn't fit at the column's foot.
        const need = m.height - QUESTION_GAP;
        if (need > full) throw new QuestionTooLongError(index, 0, "column");
        while (y + need > area.bottom) {
            if (col === 0) col = 1;
            else {
                pages.push({ pageNumber: pages.length + 1, columns: [[], []] });
                col = 0;
            }
            y = area.top(pages.length);
        }
        pages.at(-1)!.columns[col]!.push({ question: m, y });
        y += m.height;
    });
    return pages;
}

function renderBookletPage(test: TestDef, page: BookletPage, totalPages: number, L: LayoutSpec): string {
    const area = bookletArea(L);
    const parts: string[] = [];
    if (page.pageNumber === 1) {
        parts.push(titleSvg(test.title, L), svgText(area.colX(0), rowY(4, L) + L.cellH * 0.72, BOOKLET_INSTRUCTIONS, INSTRUCTIONS_ATTRS));
    }
    parts.push(footerSvg(test.title, `Page ${page.pageNumber} of ${totalPages}`, L));
    const used = page.columns.map((c) => (c.length ? c.at(-1)!.y + c.at(-1)!.question.height - QUESTION_GAP : 0));
    if (page.columns[1]!.length) {
        const top = area.top(page.pageNumber);
        parts.push(`<line x1="${f(area.dividerX)}" y1="${f(top)}" x2="${f(area.dividerX)}" y2="${f(Math.max(...used))}" stroke="#999" stroke-width="0.6"/>`);
    }
    let figureCount = 0;
    page.columns.forEach((list, c) => {
        const x = area.colX(c);
        for (const { question: q, y } of list) {
            const px = x + promptIndent(q.index);
            parts.push(numberBadge(q.index, x, y + FIRST_LINE / 2, q.promptLines[0] ?? ""));
            q.promptLines.forEach((line, i) =>
                parts.push(svgText(px, y + FIRST_LINE / 2 + 0.358 * TEXT_SIZE + i * LEAD, line, `font-size="${TEXT_SIZE}" font-weight="bold"`)),
            );
            for (const fb of q.figures) {
                // A figure can appear twice on a page (shared by two questions), so ids get a per-placement prefix.
                const svg = renderFigure(fb.figure, 0, 0, `b${page.pageNumber}f${++figureCount}-`);
                parts.push(`<g transform="translate(${f(x + fb.dx)} ${f(y + fb.dy)})${fb.scale < 1 ? ` scale(${+fb.scale.toFixed(4)})` : ""}">${svg}</g>`);
            }
            q.note?.lines.forEach((line, k) =>
                parts.push(svgText(x + q.note!.dx, y + q.note!.dy + k * LEAD, line, `font-size="${TEXT_SIZE}" font-style="italic" fill="#333"`)),
            );
            q.choices.forEach((cell, i) => {
                parts.push(svgText(x + cell.dx, y + cell.dy, `${CHOICE_LETTERS[i]}.`, `font-size="${TEXT_SIZE}" font-weight="bold"`));
                cell.lines.forEach((line, k) => parts.push(svgText(x + cell.dx + CHOICE_LABEL_W, y + cell.dy + k * LEAD, line, `font-size="${TEXT_SIZE}"`)));
            });
        }
    });
    return pageSvg(parts.join(""), L);
}

// ---- Answer sheet --------------------------------------------------------------

export interface AnswerQuestion {
    index: number;
    /** Grid row of its bubbles. */
    row: number;
    /** Its block, 0 = leftmost. */
    block: number;
    /** Bubble centres, A first, page units. */
    centers: Point[];
    /** Its run of multiple-choice questions on the page (0 on a page without boxes). */
    segment: number;
}

/** A free-response question's box on the answer sheet: its number on `labelRow`, the box below. */
export interface AnswerBox {
    index: number;
    labelRow: number;
    row: number;
    rows: number;
}

export interface AnswerPageLayout {
    /** 1-based among the answer sheet's pages (the QR's page number). */
    pageNumber: number;
    grid: AnswerGridSpec;
    questions: AnswerQuestion[];
    /** Free-response boxes, in test order; a page with any is a version 7 page. */
    boxes: AnswerBox[];
}

/** Questions per block on a page of `n` questions in `blocks` blocks: whole groups of five, as few as hold them. */
function rowsPerBlock(n: number, blocks: number): number {
    return Math.min(ANSWER_MAX_ROWS, Math.ceil(Math.ceil(n / blocks) / BAND_ROWS) * BAND_ROWS);
}

/**
 * Questions per block in a segment of `n` between boxes: as few rows as hold them, rounded up to
 * whole groups of five once it takes more than five, but never past `room` rows. Null if they
 * don't fit in `room`.
 */
function segmentRowsPerBlock(n: number, blocks: number, room: number): number | null {
    const need = Math.ceil(n / blocks);
    if (need > room) return null;
    return need <= BAND_ROWS ? need : Math.min(room, Math.ceil(need / BAND_ROWS) * BAND_ROWS);
}

/** Lays out questions `ids` on one answer page, or returns null if they don't fit it. */
function layoutAnswerPage(test: TestDef, ids: number[], pageNumber: number, L: LayoutSpec): AnswerPageLayout | null {
    const qs = ids.map((i) => test.questions[i]!);
    const counts = qs.map((q) => (isFree(q) ? 0 : q.choices.length));
    if (answerPayloadByteLength(counts) > MAX_ANSWER_PAYLOAD_BYTES) return null;
    const slots = Math.max(1, ...counts);
    const g = answerGridGeometry(slots, L);
    const place = (k: number, index: number, row: number, block: number, segment: number): AnswerQuestion => ({
        index,
        row,
        block,
        segment,
        centers: Array.from({ length: counts[k]! }, (_, j) => answerBubbleCenter(block, j, row, slots, L)),
    });

    if (!counts.includes(0)) {
        if (ids.length > g.blocks * ANSWER_MAX_ROWS) return null;
        const grid = { slots, rowsPerBlock: rowsPerBlock(ids.length, g.blocks) };
        const questions = ids.map((index, k) => place(k, index, answerRow(k, grid.rowsPerBlock), Math.floor(k / grid.rowsPerBlock), 0));
        return { pageNumber, grid, questions, boxes: [] };
    }

    // Runs of multiple-choice questions and boxes, down the page in test order, a blank row between them.
    const questions: AnswerQuestion[] = [];
    const boxes: AnswerBox[] = [];
    let row = ANSWER_FIRST_ROW;
    let segment = 0;
    for (let k = 0; k < ids.length; ) {
        if (k) row++;
        if (counts[k] === 0) {
            const rows = qs[k]!.lines! * ROWS_PER_LINE;
            boxes.push({ index: ids[k]!, labelRow: row, row: row + 1, rows });
            row += 1 + rows;
            k++;
            continue;
        }
        let n = 0;
        while (k + n < ids.length && counts[k + n] !== 0) n++;
        const rpb = segmentRowsPerBlock(n, g.blocks, ANSWER_LAST_ROW - row + 1);
        if (rpb === null) return null;
        for (let i = 0; i < n; i++) questions.push(place(k + i, ids[k + i]!, row + (i % rpb), Math.floor(i / rpb), segment));
        segment++;
        row += rpb;
        k += n;
    }
    if (row - 1 > ANSWER_LAST_ROW) return null;
    return { pageNumber, grid: { slots }, questions, boxes };
}

/** Puts every question on an answer sheet page, in order, filling each page before the next. */
export function layoutAnswerSheet(test: TestDef, L: LayoutSpec = LAYOUT): AnswerPageLayout[] {
    const pages: AnswerPageLayout[] = [];
    let ids: number[] = [];
    let current: AnswerPageLayout | null = null;
    test.questions.forEach((_, index) => {
        const next = layoutAnswerPage(test, [...ids, index], pages.length + 1, L);
        if (next) {
            ids.push(index);
            current = next;
            return;
        }
        if (current) pages.push(current);
        ids = [index];
        current = layoutAnswerPage(test, ids, pages.length + 1, L);
        if (!current) throw new QuestionTooLongError(index, 0, "page");
    });
    if (current) pages.push(current);
    return pages;
}

export function answerPayloadFor(test: TestDef, pages: AnswerPageLayout[], page: AnswerPageLayout): PagePayload {
    // Questions and boxes back in test order.
    const items = [
        ...page.questions.map((q) => ({ index: q.index, rows: q.centers.map(() => q.row), block: q.block, box: null })),
        ...page.boxes.map((b) => ({ index: b.index, rows: [] as number[], block: 0, box: { row: b.row, rows: b.rows } })),
    ].sort((a, b) => a.index - b.index);
    const free = page.boxes.length > 0;
    return {
        version: free ? FREE_ANSWER_FORMAT_VERSION : ANSWER_FORMAT_VERSION,
        totalPages: pages.length,
        pageNumber: page.pageNumber,
        totalQuestions: test.questions.length,
        questionsOnPage: items.length,
        firstQuestionIndex: items[0]?.index ?? 0,
        choiceRows: items.map((it) => it.rows),
        columns: items.map(() => 0),
        answerGrid: page.grid,
        ...(free ? { boxes: items.map((it) => it.box), blocks: items.map((it) => it.block) } : {}),
    };
}

function renderAnswerPage(test: TestDef, page: AnswerPageLayout, payload: PagePayload, label: string, L: LayoutSpec): string {
    const parts: string[] = [cornerSquaresSvg(L), qrSvg(pack(payload), L), titleSvg(test.title, L)];
    const x = colX(L.promptCol, L);
    const y = instructionsBaseline(L);
    const heading = page.pageNumber === 1 ? "ANSWER SHEET" : "ANSWER SHEET (continued)";
    parts.push(svgText(x, y, heading, `font-size="10" font-weight="bold"`));
    if (page.pageNumber === 1) {
        parts.push(fieldsSvg(L), svgText(x + textWidth(heading, 10, true) + 10, y, ANSWER_INSTRUCTIONS, INSTRUCTIONS_ATTRS));
    }
    parts.push(footerSvg(test.title, label, L));

    const g = answerGridGeometry(page.grid.slots, L);
    const r = answerRingRadius(L);
    // Bands behind every other group of five rows, per segment and block, as far as that block's questions go.
    const segments = new Set(page.questions.map((q) => q.segment));
    for (const s of segments) {
        for (let b = 0; b < g.blocks; b++) {
            const rows = page.questions.filter((q) => q.segment === s && q.block === b).map((q) => q.row);
            if (!rows.length) continue;
            const last = Math.max(...rows);
            for (let from = rows[0]! + BAND_ROWS; from <= last; from += 2 * BAND_ROWS) {
                const to = Math.min(last, from + BAND_ROWS - 1);
                parts.push(
                    `<rect x="${f(g.blockX(b) - BAND_PAD)}" y="${f(rowY(from, L))}" width="${f(g.blockW + 2 * BAND_PAD)}" height="${f(rowY(to + 1, L) - rowY(from, L))}" fill="${BAND_FILL}"/>`,
                );
            }
        }
    }
    const markerRows = new Set<number>();
    for (const q of page.questions) {
        markerRows.add(q.row);
        const mid = rowY(q.row, L) + L.cellH / 2;
        parts.push(
            svgText(g.blockX(q.block) + L.answer.numberW, mid + 0.358 * ANSWER_NUMBER_SIZE, String(q.index + 1), `font-size="${ANSWER_NUMBER_SIZE}" font-weight="bold" text-anchor="end"`),
        );
        q.centers.forEach((c, j) => {
            // White inside, so a band never shades a bubble; the letter faint enough to read as blank.
            parts.push(`<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(r)}" fill="#fff" stroke="#000" stroke-width="${L.ring.strokeWidth}"/>`);
            parts.push(svgText(c.x, c.y + 0.358 * ANSWER_LETTER_SIZE, CHOICE_LETTERS[j]!, `font-size="${ANSWER_LETTER_SIZE}" text-anchor="middle" fill="${ANSWER_LETTER_FILL}"`));
        });
    }
    for (const b of page.boxes) {
        const base = rowY(b.labelRow, L) + L.cellH * 0.72;
        const num = String(b.index + 1);
        parts.push(svgText(x, base, num, `font-size="${ANSWER_NUMBER_SIZE}" font-weight="bold"`));
        parts.push(svgText(x + textWidth(num, ANSWER_NUMBER_SIZE, true) + 8, base, BOX_LABEL, INSTRUCTIONS_ATTRS));
        parts.push(responseBoxSvg(b.row, b.rows, L));
    }
    parts.push(markersSvg(markerRows, L));
    return parts.join("");
}

// ---- Both ----------------------------------------------------------------------

export interface RenderedAnswerPage {
    page: AnswerPageLayout;
    payload: PagePayload;
    svg: string;
}

export interface SeparateSheets {
    /** The question pages, in order. */
    questionPages: string[];
    /** A page left blank after an odd number of question pages, or null; see blankPagesAfter. */
    blankPage: string | null;
    /** The answer sheet's pages, which follow them. */
    answerPages: RenderedAnswerPage[];
}

/**
 * Blank pages to print between `questionPages` question pages and the answer sheet, so that
 * printed double-sided the answer sheet starts on a sheet of its own: it can be handed out and
 * scanned loose, without unstapling the questions.
 */
export const blankPagesAfter = (questionPages: number) => questionPages % 2;

const BLANK_PAGE_NOTE = "This page is intentionally left blank.";

function renderBlankPage(test: TestDef, pageNumber: number, totalPages: number, L: LayoutSpec): string {
    const note = svgText(L.pageWidth / 2, L.pageHeight / 2, BLANK_PAGE_NOTE, `${INSTRUCTIONS_ATTRS} text-anchor="middle"`);
    return pageSvg(note + footerSvg(test.title, `Page ${pageNumber} of ${totalPages}`, L), L);
}

export interface SeparateRenderOptions {
    /** Extra SVG (e.g. simulated pencil) drawn on top of an answer sheet page. */
    overlay?: (page: AnswerPageLayout) => string;
    layout?: LayoutSpec;
}

/** Renders the question pages, a blank page if needed, then the answer sheet, numbered as one document. */
export function renderSeparate(test: TestDef, opts: SeparateRenderOptions = {}): SeparateSheets {
    const L = opts.layout ?? LAYOUT;
    const booklet = layoutBooklet(test, L);
    const answers = layoutAnswerSheet(test, L);
    if (answers.length > MAX_PAGES) throw new RangeError(`the answer sheet needs ${answers.length} pages (max ${MAX_PAGES})`);
    const before = booklet.length + blankPagesAfter(booklet.length);
    const total = before + answers.length;
    return {
        questionPages: booklet.map((p) => renderBookletPage(test, p, total, L)),
        blankPage: before > booklet.length ? renderBlankPage(test, before, total, L) : null,
        answerPages: answers.map((page) => {
            const payload = answerPayloadFor(test, answers, page);
            const body = renderAnswerPage(test, page, payload, `Page ${before + page.pageNumber} of ${total}`, L);
            return { page, payload, svg: pageSvg(body + (opts.overlay?.(page) ?? ""), L) };
        }),
    };
}
