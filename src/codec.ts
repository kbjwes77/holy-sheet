// QR payload codec shared by the grader and the sheet generators. Dependency-free on
// purpose: `bun run build:shared` emits it as a plain ES module for the browser generator.
//
// Layout (MSB-first, final byte zero-padded):
//   version 4 | totalPages 5 | pageNumber 5 | totalQuestions 9 | questionsOnPage 9 |
//   firstQuestionIndex 9 | twoColumns 1 |
//   per question: (choice count − 1) 3, then its column 1 (only when twoColumns) |
//   column 0 bubble-row mask 54 | column 1 bubble-row mask 54 (only when twoColumns)
//
// Column 0 holds full-width questions and the left column, whose bubbles share one bubble
// column; column 1 is the right column. Each mask has one bit per question row (first bit =
// row 4, last = row 57), set for every row holding a bubble in that column. Set rows are handed
// out top to bottom to that column's questions in order: the first takes as many rows as it has
// choices (A, B, …), then the next, and so on.

// Version 4 moved the QR and page 1's header up a row (version 3 sheets' name box is elsewhere).
export const FORMAT_VERSION = 4;
export const HEADER_BITS = 42;
export const CHOICE_COUNT_BITS = 3;
/** The rows a mask covers: every row a question can use (LayoutSpec firstRowContinued–bodyLastRow). */
export const MASK_FIRST_ROW = 4;
export const MASK_LAST_ROW = 57;
export const MASK_ROWS = MASK_LAST_ROW - MASK_FIRST_ROW + 1;
export const MAX_PAGES = 16;
export const MAX_QUESTIONS = 256;
export const MAX_CHOICES = 8;

/** 0 for a full-width or left-column question, 1 for a right-column one. */
export type PayloadColumn = 0 | 1;

export interface PagePayload {
    version: number;
    totalPages: number;
    /** 1-based */
    pageNumber: number;
    totalQuestions: number;
    questionsOnPage: number;
    /** 0-based index of this page's first question */
    firstQuestionIndex: number;
    /** Per question on this page, the 1-based grid rows of its choice bubbles (A, B, … top to bottom). */
    choiceRows: number[][];
    /** Per question on this page, the column its bubbles are in. */
    columns: PayloadColumn[];
}

export class PayloadError extends Error {
    override name = "PayloadError";
}

export function payloadBitLength(questionsOnPage: number, twoColumns: boolean): number {
    return HEADER_BITS + (CHOICE_COUNT_BITS + (twoColumns ? 1 : 0)) * questionsOnPage + MASK_ROWS * (twoColumns ? 2 : 1);
}

export function payloadByteLength(questionsOnPage: number, twoColumns: boolean): number {
    return Math.ceil(payloadBitLength(questionsOnPage, twoColumns) / 8);
}

function validate(p: PagePayload): void {
    const intIn = (name: string, v: number, lo: number, hi: number) => {
        if (!Number.isInteger(v) || v < lo || v > hi) throw new PayloadError(`${name} ${v} is outside ${lo}–${hi}`);
    };
    if (p.version !== FORMAT_VERSION) throw new PayloadError(`unknown payload version ${p.version}`);
    intIn("totalPages", p.totalPages, 0, MAX_PAGES);
    intIn("pageNumber", p.pageNumber, 0, MAX_PAGES);
    intIn("totalQuestions", p.totalQuestions, 0, MAX_QUESTIONS);
    intIn("questionsOnPage", p.questionsOnPage, 0, MAX_QUESTIONS);
    intIn("firstQuestionIndex", p.firstQuestionIndex, 0, MAX_QUESTIONS - 1);
    if (p.pageNumber === 0 || p.pageNumber > p.totalPages) {
        throw new PayloadError(`pageNumber ${p.pageNumber} is not within 1–${p.totalPages}`);
    }
    if (p.firstQuestionIndex + p.questionsOnPage > p.totalQuestions) {
        throw new PayloadError(
            `questions ${p.firstQuestionIndex}+${p.questionsOnPage} exceed totalQuestions ${p.totalQuestions}`,
        );
    }
    if (p.choiceRows.length !== p.questionsOnPage) {
        throw new PayloadError(`${p.choiceRows.length} questions' rows given for ${p.questionsOnPage} questions`);
    }
    if (p.columns.length !== p.questionsOnPage) {
        throw new PayloadError(`${p.columns.length} questions' columns given for ${p.questionsOnPage} questions`);
    }
    const last = [0, 0];
    p.choiceRows.forEach((rows, i) => {
        const col = p.columns[i]!;
        if (col !== 0 && col !== 1) throw new PayloadError(`question ${i + 1} column ${col} is not 0 or 1`);
        intIn(`question ${i + 1} choice count`, rows.length, 1, MAX_CHOICES);
        for (const row of rows) {
            intIn("row", row, MASK_FIRST_ROW, MASK_LAST_ROW);
            if (row <= last[col]!) {
                throw new PayloadError(`bubble rows must increase down each column (row ${row} after ${last[col]} in column ${col})`);
            }
            last[col] = row;
        }
    });
}

export function pack(p: PagePayload): Uint8Array {
    validate(p);
    const two = p.columns.includes(1);
    const out = new Uint8Array(payloadByteLength(p.questionsOnPage, two));
    let bit = 0;
    const put = (value: number, width: number) => {
        for (let i = width - 1; i >= 0; i--, bit++) {
            if ((value >> i) & 1) out[bit >> 3]! |= 0x80 >> (bit & 7);
        }
    };
    put(p.version, 4);
    put(p.totalPages, 5);
    put(p.pageNumber, 5);
    put(p.totalQuestions, 9);
    put(p.questionsOnPage, 9);
    put(p.firstQuestionIndex, 9);
    put(two ? 1 : 0, 1);
    p.choiceRows.forEach((rows, i) => {
        put(rows.length - 1, CHOICE_COUNT_BITS);
        if (two) put(p.columns[i]!, 1);
    });
    for (const col of two ? [0, 1] : [0]) {
        const used = new Set(p.choiceRows.filter((_, i) => p.columns[i] === col).flat());
        for (let row = MASK_FIRST_ROW; row <= MASK_LAST_ROW; row++) put(used.has(row) ? 1 : 0, 1);
    }
    return out;
}

export function unpack(bytes: Uint8Array): PagePayload {
    if (bytes.length * 8 < HEADER_BITS) throw new PayloadError(`payload is only ${bytes.length} bytes`);
    let bit = 0;
    const take = (width: number) => {
        let v = 0;
        for (let i = 0; i < width; i++, bit++) v = (v << 1) | ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
        return v;
    };
    const version = take(4);
    if (version !== FORMAT_VERSION) {
        throw new PayloadError(
            `unknown payload version ${version}${version < FORMAT_VERSION ? " (sheet printed with an older layout; reprint it)" : ""}`,
        );
    }
    const totalPages = take(5);
    const pageNumber = take(5);
    const totalQuestions = take(9);
    const questionsOnPage = take(9);
    const firstQuestionIndex = take(9);
    const two = take(1) === 1;
    const expected = payloadByteLength(questionsOnPage, two);
    if (bytes.length !== expected) {
        throw new PayloadError(`payload is ${bytes.length} bytes, expected ${expected} for ${questionsOnPage} questions`);
    }
    const counts: number[] = [];
    const columns: PayloadColumn[] = [];
    for (let i = 0; i < questionsOnPage; i++) {
        counts.push(take(CHOICE_COUNT_BITS) + 1);
        columns.push(two && take(1) ? 1 : 0);
    }
    const choiceRows: number[][] = counts.map(() => []);
    for (const col of two ? [0, 1] : [0]) {
        const rows: number[] = [];
        for (let row = MASK_FIRST_ROW; row <= MASK_LAST_ROW; row++) if (take(1)) rows.push(row);
        const mine = counts.flatMap((_, i) => (columns[i] === col ? [i] : []));
        const needed = mine.reduce((sum, i) => sum + counts[i]!, 0);
        if (rows.length !== needed) {
            throw new PayloadError(`${rows.length} bubble rows marked in column ${col}, expected ${needed} for the choice counts`);
        }
        let at = 0;
        for (const i of mine) {
            choiceRows[i] = rows.slice(at, at + counts[i]!);
            at += counts[i]!;
        }
    }
    const p: PagePayload = { version, totalPages, pageNumber, totalQuestions, questionsOnPage, firstQuestionIndex, choiceRows, columns };
    validate(p);
    return p;
}
