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
//
// Version 5 is a separate answer sheet: one row per question with its bubbles side by side, in
// blocks across the page, the questions themselves printed on unscanned pages before it:
//   version 4 | totalPages 5 | pageNumber 5 | totalQuestions 9 | questionsOnPage 9 |
//   firstQuestionIndex 9 | (slots − 1) 3 | rowsPerBlock 6 | runs 1 |
//   runs = 0: per question (choice count − 1) 3
//   runs = 1: (run count − 1) 8, then per run (choice count − 1) 3 and (run length − 1) 8
// Question k on the page (0-based) is on grid row ANSWER_FIRST_ROW + k mod rowsPerBlock, in block
// ⌊k / rowsPerBlock⌋. `slots` is the most choices any question on the page has, which sets the
// blocks' width (see `answerGridGeometry` in layout.ts). Runs encode the usual case, every
// question with the same number of choices, in a few bytes; the shorter encoding is used.
//
// Versions 6 and 7 are versions 4 and 5 for pages that hold free-response questions, each a
// full-width box for a written answer. Their choice code 0 (one choice in versions 4 and 5)
// marks a free-response question; multiple-choice questions there have 2–8 choices.
//   Version 6 is version 4, with each free-response question's code followed by its box's
//   first row 6 and (row count − 1) 6. Its column bit, when there is one, is 0; masks skip it.
//   Version 7: version 4 | totalPages 5 | pageNumber 5 | totalQuestions 9 | questionsOnPage 9 |
//   firstQuestionIndex 9 | (slots − 1) 3 | runs 1 | the codes, as in version 5 | then, in
//   question order, for each segment (a run of multiple-choice questions) its first row 6 and
//   rowsPerBlock 6, and for each free-response question its box's first row 6 and
//   (row count − 1) 6.
// Question k (0-based) of a version 7 segment is on its first row + k mod rowsPerBlock, in block
// ⌊k / rowsPerBlock⌋, so the boxes sit between bands of bubble rows, in test order.

// Version 4 moved the QR and page 1's header up a row (version 3 sheets' name box is elsewhere).
export const FORMAT_VERSION = 4;
export const ANSWER_FORMAT_VERSION = 5;
/** Versions 4 and 5 with free-response boxes. */
export const FREE_FORMAT_VERSION = 6;
export const FREE_ANSWER_FORMAT_VERSION = 7;
const VERSIONS = [FORMAT_VERSION, ANSWER_FORMAT_VERSION, FREE_FORMAT_VERSION, FREE_ANSWER_FORMAT_VERSION];
export const HEADER_BITS = 42;
export const ANSWER_HEADER_BITS = 51;
const FREE_ANSWER_HEADER_BITS = ANSWER_HEADER_BITS - 6;
export const CHOICE_COUNT_BITS = 3;
const RUN_LENGTH_BITS = 8;
const ROW_BITS = 6;
/** The choice code of a free-response question in versions 6 and 7. */
const FREE_CODE = 0;
/** The rows a mask covers: every row a question can use (LayoutSpec firstRowContinued–bodyLastRow). */
export const MASK_FIRST_ROW = 4;
export const MASK_LAST_ROW = 57;
export const MASK_ROWS = MASK_LAST_ROW - MASK_FIRST_ROW + 1;
/** An answer sheet's bubble rows, on every page: below page 1's header, down to the last question row. */
export const ANSWER_FIRST_ROW = 9;
export const ANSWER_LAST_ROW = 57;
export const ANSWER_MAX_ROWS = ANSWER_LAST_ROW - ANSWER_FIRST_ROW + 1;
export const MAX_PAGES = 16;
export const MAX_QUESTIONS = 256;
export const MAX_CHOICES = 8;
/** The most grid rows a free-response box can take. */
export const MAX_BOX_ROWS = MASK_ROWS;

/** 0 for a full-width or left-column question, 1 for a right-column one. */
export type PayloadColumn = 0 | 1;

export interface AnswerGridSpec {
    /** Bubble positions per block row: the most choices any question on the page has. */
    slots: number;
    /** Version 5 only: questions per block, top to bottom, before the next block starts. */
    rowsPerBlock?: number;
}

/** A free-response question's writing box: full width, over grid rows [row, row + rows). */
export interface ResponseBox {
    row: number;
    rows: number;
}

export interface PagePayload {
    version: number;
    totalPages: number;
    /** 1-based */
    pageNumber: number;
    totalQuestions: number;
    questionsOnPage: number;
    /** 0-based index of this page's first question */
    firstQuestionIndex: number;
    /**
     * Per question on this page, the 1-based grid rows of its choice bubbles (A, B, … top to
     * bottom). On an answer sheet the bubbles are side by side, so its row repeats once per choice.
     * Empty for a free-response question.
     */
    choiceRows: number[][];
    /** Per question on this page, the column its bubbles are in (always 0 on an answer sheet). */
    columns: PayloadColumn[];
    /** Answer sheets (versions 5 and 7) only. */
    answerGrid?: AnswerGridSpec;
    /**
     * Versions 6 and 7 only: per question on this page, its writing box when it is a
     * free-response question, else null.
     */
    boxes?: (ResponseBox | null)[];
    /** Version 7 only: per question on this page, the block its bubbles are in (0 for a box). */
    blocks?: number[];
}

export class PayloadError extends Error {
    override name = "PayloadError";
}

/** Whether a payload version is an answer sheet's (5 or 7). */
export function isAnswerSheet(version: number): boolean {
    return version === ANSWER_FORMAT_VERSION || version === FREE_ANSWER_FORMAT_VERSION;
}

/** The grid row of question `k` (0-based on its page) on a version 5 answer sheet. */
export function answerRow(k: number, rowsPerBlock: number): number {
    return ANSWER_FIRST_ROW + (k % rowsPerBlock);
}

/** The block holding question `k`'s bubbles (0-based on its page) on an answer sheet page. */
export function answerBlock(p: PagePayload, k: number): number {
    return p.blocks ? p.blocks[k]! : Math.floor(k / p.answerGrid!.rowsPerBlock!);
}

export function payloadBitLength(questionsOnPage: number, twoColumns: boolean, boxes = 0): number {
    return HEADER_BITS + (CHOICE_COUNT_BITS + (twoColumns ? 1 : 0)) * questionsOnPage + MASK_ROWS * (twoColumns ? 2 : 1) + 2 * ROW_BITS * boxes;
}

/** Bytes of a version 4 page, or of a version 6 page with `boxes` free-response questions. */
export function payloadByteLength(questionsOnPage: number, twoColumns: boolean, boxes = 0): number {
    return Math.ceil(payloadBitLength(questionsOnPage, twoColumns, boxes) / 8);
}

/** Runs of equal values, as [value, length] pairs. */
function runsOf(values: readonly number[]): [number, number][] {
    const runs: [number, number][] = [];
    for (const c of values) {
        const last = runs.at(-1);
        if (last && last[0] === c && last[1] < 1 << RUN_LENGTH_BITS) last[1]++;
        else runs.push([c, 1]);
    }
    return runs;
}

/** Whether an answer sheet page's choice codes are encoded as runs, and their length in bits. */
function codesEncoding(codes: readonly number[]): { runs: boolean; bits: number } {
    const raw = CHOICE_COUNT_BITS * codes.length;
    const n = runsOf(codes).length;
    const rle = n && n <= 1 << RUN_LENGTH_BITS ? RUN_LENGTH_BITS + n * (CHOICE_COUNT_BITS + RUN_LENGTH_BITS) : Infinity;
    return { runs: rle < raw, bits: 1 + Math.min(rle, raw) };
}

/** Version 7 items in question order: a segment starts at each MC question after a box (or first). */
function freeAnswerItems(counts: readonly number[]): number {
    return counts.filter((c, k) => c === 0 || k === 0 || counts[k - 1] === 0).length;
}

/**
 * Payload bytes of an answer sheet page whose questions have these choice counts, 0 standing
 * for a free-response question (which makes it a version 7 page).
 */
export function answerPayloadByteLength(counts: readonly number[]): number {
    if (!counts.includes(0)) return Math.ceil((ANSWER_HEADER_BITS - 1 + codesEncoding(counts.map((c) => c - 1)).bits) / 8);
    const codes = counts.map((c) => (c === 0 ? FREE_CODE : c - 1));
    return Math.ceil((FREE_ANSWER_HEADER_BITS - 1 + codesEncoding(codes).bits + freeAnswerItems(counts) * 2 * ROW_BITS) / 8);
}

type IntIn = (name: string, v: number, lo: number, hi: number) => void;

const intIn: IntIn = (name, v, lo, hi) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new PayloadError(`${name} ${v} is outside ${lo}–${hi}`);
};

const hasBoxes = (version: number) => version === FREE_FORMAT_VERSION || version === FREE_ANSWER_FORMAT_VERSION;

function validate(p: PagePayload): void {
    if (!VERSIONS.includes(p.version)) throw new PayloadError(`unknown payload version ${p.version}`);
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
    const free = hasBoxes(p.version);
    if (!free && (p.boxes || p.blocks)) throw new PayloadError(`a version ${p.version} payload has no free-response boxes`);
    if (free) {
        if (p.boxes?.length !== p.questionsOnPage) throw new PayloadError(`a version ${p.version} payload needs a box entry per question`);
        p.boxes.forEach((box, i) => {
            if (!box) {
                // Code 0 marks a box in versions 6 and 7.
                if (p.choiceRows[i]!.length < 2) throw new PayloadError(`question ${i + 1} choice count ${p.choiceRows[i]!.length} is outside 2–${MAX_CHOICES}`);
                return;
            }
            if (p.choiceRows[i]!.length) throw new PayloadError(`free-response question ${i + 1} has bubbles`);
            if (p.columns[i] !== 0) throw new PayloadError(`free-response question ${i + 1} must be in column 0`);
            intIn(`question ${i + 1} box rows`, box.rows, 1, MAX_BOX_ROWS);
        });
    }
    if (isAnswerSheet(p.version)) {
        validateAnswerGrid(p);
        return;
    }
    if (p.answerGrid) throw new PayloadError(`a version ${p.version} payload has no answer grid`);
    const last = [0, 0];
    const boxRows = new Set<number>();
    p.choiceRows.forEach((rows, i) => {
        const col = p.columns[i]!;
        if (col !== 0 && col !== 1) throw new PayloadError(`question ${i + 1} column ${col} is not 0 or 1`);
        const box = p.boxes?.[i];
        if (box) {
            intIn(`question ${i + 1} box row`, box.row, MASK_FIRST_ROW, MASK_LAST_ROW - box.rows + 1);
            if (box.row <= last[0]!) throw new PayloadError(`question ${i + 1}'s box starts on row ${box.row}, above row ${last[0]} in column 0`);
            for (let r = box.row; r < box.row + box.rows; r++) boxRows.add(r);
            last[0] = box.row + box.rows - 1;
            return;
        }
        intIn(`question ${i + 1} choice count`, rows.length, 1, MAX_CHOICES);
        for (const row of rows) {
            intIn("row", row, MASK_FIRST_ROW, MASK_LAST_ROW);
            if (row <= last[col]!) {
                throw new PayloadError(`bubble rows must increase down each column (row ${row} after ${last[col]} in column ${col})`);
            }
            last[col] = row;
        }
    });
    for (const row of p.choiceRows.flat()) if (boxRows.has(row)) throw new PayloadError(`row ${row} has both bubbles and a free-response box`);
}

/** A version 7 page's segments (runs of multiple-choice questions), each with its rows per block. */
interface Segment {
    /** Index on the page of its first question. */
    start: number;
    count: number;
    firstRow: number;
    rowsPerBlock: number;
}

function segmentsOf(p: PagePayload): Segment[] {
    const segs: Segment[] = [];
    p.choiceRows.forEach((rows, k) => {
        if (p.boxes?.[k]) return;
        const last = segs.at(-1);
        if (last && last.start + last.count === k) last.count++;
        else segs.push({ start: k, count: 1, firstRow: rows[0] ?? 0, rowsPerBlock: 0 });
    });
    for (const s of segs) {
        // Questions per block: those in block 0 (all of them when there's only one block).
        let n = 0;
        while (n < s.count && p.blocks![s.start + n] === 0) n++;
        s.rowsPerBlock = n;
    }
    return segs;
}

function validateAnswerGrid(p: PagePayload): void {
    const g = p.answerGrid;
    if (!g) throw new PayloadError("an answer sheet payload needs its answer grid");
    intIn("slots", g.slots, 1, MAX_CHOICES);
    p.choiceRows.forEach((rows, k) => {
        if (p.columns[k] !== 0) throw new PayloadError(`question ${k + 1} column ${p.columns[k]} is not 0 on an answer sheet`);
        if (!p.boxes?.[k]) intIn(`question ${k + 1} choice count`, rows.length, 1, g.slots);
    });
    if (p.version === ANSWER_FORMAT_VERSION) {
        if (p.blocks) throw new PayloadError("a version 5 payload has no blocks list");
        intIn("rowsPerBlock", g.rowsPerBlock ?? 0, 1, ANSWER_MAX_ROWS);
        p.choiceRows.forEach((rows, k) => {
            const row = answerRow(k, g.rowsPerBlock!);
            if (rows.some((r) => r !== row)) throw new PayloadError(`question ${k + 1}'s bubbles must all be on row ${row}`);
        });
        return;
    }
    if (g.rowsPerBlock !== undefined) throw new PayloadError("a version 7 payload sets rows per block per segment");
    if (p.blocks?.length !== p.questionsOnPage) throw new PayloadError("a version 7 payload needs a block per question");
    // Segments and boxes go down the page in question order, without overlapping.
    let below = ANSWER_FIRST_ROW;
    const segs = segmentsOf(p);
    p.choiceRows.forEach((rows, k) => {
        const box = p.boxes![k];
        if (box) {
            if (p.blocks![k] !== 0) throw new PayloadError(`free-response question ${k + 1} block ${p.blocks![k]} is not 0`);
            intIn(`question ${k + 1} box row`, box.row, below, ANSWER_LAST_ROW - box.rows + 1);
            below = box.row + box.rows;
            return;
        }
        const s = segs.find((s) => k >= s.start && k < s.start + s.count)!;
        if (k === s.start) {
            intIn(`question ${k + 1} row`, s.firstRow, below, ANSWER_LAST_ROW - s.rowsPerBlock + 1);
            intIn(`question ${k + 1} segment rowsPerBlock`, s.rowsPerBlock, 1, ANSWER_MAX_ROWS);
            below = s.firstRow + s.rowsPerBlock;
        }
        const i = k - s.start;
        const row = s.firstRow + (i % s.rowsPerBlock);
        if (rows.some((r) => r !== row)) throw new PayloadError(`question ${k + 1}'s bubbles must all be on row ${row}`);
        if (p.blocks![k] !== Math.floor(i / s.rowsPerBlock)) throw new PayloadError(`question ${k + 1} block ${p.blocks![k]} doesn't follow its segment`);
    });
}

function writer(out: Uint8Array) {
    let bit = 0;
    return (value: number, width: number) => {
        for (let i = width - 1; i >= 0; i--, bit++) {
            if ((value >> i) & 1) out[bit >> 3]! |= 0x80 >> (bit & 7);
        }
    };
}

function putHeader(put: (value: number, width: number) => void, p: PagePayload): void {
    put(p.version, 4);
    put(p.totalPages, 5);
    put(p.pageNumber, 5);
    put(p.totalQuestions, 9);
    put(p.questionsOnPage, 9);
    put(p.firstQuestionIndex, 9);
}

function putCodes(put: (value: number, width: number) => void, codes: number[]): void {
    const enc = codesEncoding(codes);
    put(enc.runs ? 1 : 0, 1);
    if (enc.runs) {
        const runs = runsOf(codes);
        put(runs.length - 1, RUN_LENGTH_BITS);
        for (const [code, length] of runs) {
            put(code, CHOICE_COUNT_BITS);
            put(length - 1, RUN_LENGTH_BITS);
        }
    } else {
        for (const c of codes) put(c, CHOICE_COUNT_BITS);
    }
}

export function pack(p: PagePayload): Uint8Array {
    validate(p);
    const counts = p.choiceRows.map((rows, i) => (p.boxes?.[i] ? 0 : rows.length));
    if (isAnswerSheet(p.version)) {
        const out = new Uint8Array(answerPayloadByteLength(counts));
        const put = writer(out);
        putHeader(put, p);
        put(p.answerGrid!.slots - 1, 3);
        if (p.version === ANSWER_FORMAT_VERSION) {
            put(p.answerGrid!.rowsPerBlock!, 6);
            putCodes(put, counts.map((c) => c - 1));
            return out;
        }
        putCodes(put, counts.map((c) => (c === 0 ? FREE_CODE : c - 1)));
        const segs = segmentsOf(p);
        p.boxes!.forEach((box, k) => {
            if (box) {
                put(box.row, ROW_BITS);
                put(box.rows - 1, ROW_BITS);
                return;
            }
            const s = segs.find((s) => s.start === k);
            if (s) {
                put(s.firstRow, ROW_BITS);
                put(s.rowsPerBlock, ROW_BITS);
            }
        });
        return out;
    }
    const two = p.columns.includes(1);
    const boxes = counts.filter((c) => c === 0).length;
    const out = new Uint8Array(payloadByteLength(p.questionsOnPage, two, p.version === FREE_FORMAT_VERSION ? boxes : 0));
    const put = writer(out);
    putHeader(put, p);
    put(two ? 1 : 0, 1);
    p.choiceRows.forEach((rows, i) => {
        const box = p.boxes?.[i];
        put(box ? FREE_CODE : rows.length - 1, CHOICE_COUNT_BITS);
        if (two) put(p.columns[i]!, 1);
        if (box) {
            put(box.row, ROW_BITS);
            put(box.rows - 1, ROW_BITS);
        }
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
        if (bit + width > bytes.length * 8) throw new PayloadError(`payload is only ${bytes.length} bytes`);
        let v = 0;
        for (let i = 0; i < width; i++, bit++) v = (v << 1) | ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
        return v;
    };
    const version = take(4);
    if (!VERSIONS.includes(version)) {
        throw new PayloadError(
            `unknown payload version ${version}${version < FORMAT_VERSION ? " (sheet printed with an older layout; reprint it)" : ""}`,
        );
    }
    const totalPages = take(5);
    const pageNumber = take(5);
    const totalQuestions = take(9);
    const questionsOnPage = take(9);
    const firstQuestionIndex = take(9);
    const header = { version, totalPages, pageNumber, totalQuestions, questionsOnPage, firstQuestionIndex };
    const free = hasBoxes(version);
    /** Choice count per question, 0 for a free-response one (versions 6 and 7). */
    const countOf = (code: number) => (free ? (code === FREE_CODE ? 0 : code + 1) : code + 1);

    if (isAnswerSheet(version)) {
        const slots = take(3) + 1;
        const rowsPerBlock = version === ANSWER_FORMAT_VERSION ? take(6) : undefined;
        const runs = take(1) === 1;
        const counts: number[] = [];
        if (runs) {
            const n = take(RUN_LENGTH_BITS) + 1;
            for (let i = 0; i < n && counts.length <= questionsOnPage; i++) {
                const count = countOf(take(CHOICE_COUNT_BITS));
                const length = take(RUN_LENGTH_BITS) + 1;
                for (let j = 0; j < length; j++) counts.push(count);
            }
            if (counts.length !== questionsOnPage) throw new PayloadError(`choice-count runs cover ${counts.length} questions, expected ${questionsOnPage}`);
        } else {
            for (let i = 0; i < questionsOnPage; i++) counts.push(countOf(take(CHOICE_COUNT_BITS)));
        }
        if (version === ANSWER_FORMAT_VERSION) {
            const expected = answerPayloadByteLength(counts);
            if (bytes.length !== expected) {
                throw new PayloadError(`payload is ${bytes.length} bytes, expected ${expected} for ${questionsOnPage} questions`);
            }
            if (rowsPerBlock! < 1) throw new PayloadError(`rowsPerBlock ${rowsPerBlock} is outside 1–${ANSWER_MAX_ROWS}`);
            const p: PagePayload = {
                ...header,
                choiceRows: counts.map((n, k) => new Array<number>(n).fill(answerRow(k, rowsPerBlock!))),
                columns: counts.map(() => 0),
                answerGrid: { slots, rowsPerBlock },
            };
            validate(p);
            return p;
        }
        const expected = answerPayloadByteLength(counts);
        if (bytes.length !== expected) {
            throw new PayloadError(`payload is ${bytes.length} bytes, expected ${expected} for ${questionsOnPage} questions`);
        }
        const choiceRows: number[][] = [];
        const boxes: (ResponseBox | null)[] = [];
        const blocks: number[] = [];
        let seg = { firstRow: 0, rowsPerBlock: 1, start: 0 };
        counts.forEach((n, k) => {
            if (n === 0) {
                const row = take(ROW_BITS);
                boxes.push({ row, rows: take(ROW_BITS) + 1 });
                choiceRows.push([]);
                blocks.push(0);
                return;
            }
            if (k === 0 || counts[k - 1] === 0) {
                const firstRow = take(ROW_BITS);
                const rpb = take(ROW_BITS);
                if (rpb < 1) throw new PayloadError(`question ${k + 1} segment rowsPerBlock ${rpb} is outside 1–${ANSWER_MAX_ROWS}`);
                seg = { firstRow, rowsPerBlock: rpb, start: k };
            }
            const i = k - seg.start;
            boxes.push(null);
            choiceRows.push(new Array<number>(n).fill(seg.firstRow + (i % seg.rowsPerBlock)));
            blocks.push(Math.floor(i / seg.rowsPerBlock));
        });
        const p: PagePayload = { ...header, choiceRows, columns: counts.map(() => 0), answerGrid: { slots }, boxes, blocks };
        validate(p);
        return p;
    }

    const two = take(1) === 1;
    const counts: number[] = [];
    const columns: PayloadColumn[] = [];
    const boxes: (ResponseBox | null)[] = [];
    for (let i = 0; i < questionsOnPage; i++) {
        counts.push(countOf(take(CHOICE_COUNT_BITS)));
        columns.push(two && take(1) ? 1 : 0);
        if (counts[i] === 0) {
            const row = take(ROW_BITS);
            boxes.push({ row, rows: take(ROW_BITS) + 1 });
        } else boxes.push(null);
    }
    const expected = payloadByteLength(questionsOnPage, two, counts.filter((c) => c === 0).length);
    if (bytes.length !== expected) {
        throw new PayloadError(`payload is ${bytes.length} bytes, expected ${expected} for ${questionsOnPage} questions`);
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
    const p: PagePayload = { ...header, choiceRows, columns, ...(free ? { boxes } : {}) };
    validate(p);
    return p;
}
