// QR payload codec shared by the grader and the sheet generators. Dependency-free on
// purpose: `bun run build:shared` emits it as a plain ES module for the browser generator.
//
// Layout (MSB-first, final byte zero-padded):
//   version 4 | totalPages 5 | pageNumber 5 | totalQuestions 9 | questionsOnPage 9 |
//   firstQuestionIndex 9 | questionsOnPage × (grid row − 1) 6

export const FORMAT_VERSION = 1;
export const HEADER_BITS = 41;
export const ROW_BITS = 6;
export const MAX_PAGES = 16;
export const MAX_QUESTIONS = 256;
export const GRID_ROWS = 60;

export interface PagePayload {
    version: number;
    totalPages: number;
    /** 1-based */
    pageNumber: number;
    totalQuestions: number;
    questionsOnPage: number;
    /** 0-based index of this page's first question */
    firstQuestionIndex: number;
    /** 1-based grid row of each question's ring row, in question order */
    rows: number[];
}

export class PayloadError extends Error {
    override name = "PayloadError";
}

export function payloadBitLength(questionsOnPage: number): number {
    return HEADER_BITS + ROW_BITS * questionsOnPage;
}

export function payloadByteLength(questionsOnPage: number): number {
    return Math.ceil(payloadBitLength(questionsOnPage) / 8);
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
    if (p.rows.length !== p.questionsOnPage) {
        throw new PayloadError(`${p.rows.length} rows given for ${p.questionsOnPage} questions`);
    }
    for (const row of p.rows) intIn("row", row, 1, GRID_ROWS);
}

export function pack(p: PagePayload): Uint8Array {
    validate(p);
    const out = new Uint8Array(payloadByteLength(p.questionsOnPage));
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
    for (const row of p.rows) put(row - 1, ROW_BITS);
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
    if (version !== FORMAT_VERSION) throw new PayloadError(`unknown payload version ${version}`);
    const totalPages = take(5);
    const pageNumber = take(5);
    const totalQuestions = take(9);
    const questionsOnPage = take(9);
    const firstQuestionIndex = take(9);
    const expected = payloadByteLength(questionsOnPage);
    if (bytes.length !== expected) {
        throw new PayloadError(`payload is ${bytes.length} bytes, expected ${expected} for ${questionsOnPage} questions`);
    }
    const rows: number[] = [];
    for (let i = 0; i < questionsOnPage; i++) rows.push(take(ROW_BITS) + 1);
    const p: PagePayload = { version, totalPages, pageNumber, totalQuestions, questionsOnPage, firstQuestionIndex, rows };
    validate(p);
    return p;
}
