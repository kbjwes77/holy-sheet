import { describe, expect, test } from "bun:test";
import { MASK_FIRST_ROW, MASK_LAST_ROW, MASK_ROWS, pack, payloadByteLength, unpack, PayloadError, type PagePayload, type PayloadColumn } from "../src/codec.ts";
import { LAYOUT } from "../src/layout.ts";
import { Rng } from "../gen/rng.ts";

const base: PagePayload = {
    version: 4,
    totalPages: 3,
    pageNumber: 2,
    totalQuestions: 40,
    questionsOnPage: 3,
    firstQuestionIndex: 10,
    choiceRows: [
        [11, 12, 13, 14],
        [17, 18, 20],
        [52, 53, 54, 55, 56, 57],
    ],
    columns: [0, 0, 0],
};

/** A page with a full-width question, then a band: two left-column questions and one right-column one. */
const twoCol: PagePayload = {
    version: 4,
    totalPages: 2,
    pageNumber: 2,
    totalQuestions: 20,
    questionsOnPage: 4,
    firstQuestionIndex: 16,
    choiceRows: [
        [4, 5, 6, 7],
        [10, 11, 12],
        [15, 16, 17, 18],
        [10, 11, 13, 14, 15],
    ],
    columns: [0, 0, 0, 1],
};

/** `count` distinct question rows, ascending. */
function sampleRows(rng: Rng, count: number): number[] {
    const all = Array.from({ length: MASK_ROWS }, (_, i) => MASK_FIRST_ROW + i);
    for (let i = all.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [all[i], all[j]] = [all[j]!, all[i]!];
    }
    return all.slice(0, count).sort((a, b) => a - b);
}

describe("codec", () => {
    test("masks cover exactly the rows questions can use", () => {
        expect(MASK_FIRST_ROW).toBe(LAYOUT.firstRowContinued);
        expect(MASK_LAST_ROW).toBe(LAYOUT.bodyLastRow);
    });

    test("round-trips a typical page", () => {
        expect(unpack(pack(base))).toEqual(base);
    });

    test("round-trips a two-column page, including rows used by both columns", () => {
        expect(unpack(pack(twoCol))).toEqual(twoCol);
    });

    test("round-trips boundary values", () => {
        const cases: PagePayload[] = [
            { version: 4, totalPages: 1, pageNumber: 1, totalQuestions: 0, questionsOnPage: 0, firstQuestionIndex: 0, choiceRows: [], columns: [] },
            { version: 4, totalPages: 16, pageNumber: 16, totalQuestions: 256, questionsOnPage: 1, firstQuestionIndex: 255, choiceRows: [[57]], columns: [0] },
            { version: 4, totalPages: 16, pageNumber: 16, totalQuestions: 256, questionsOnPage: 1, firstQuestionIndex: 255, choiceRows: [[4]], columns: [1] },
            {
                version: 4,
                totalPages: 1,
                pageNumber: 1,
                totalQuestions: 256,
                questionsOnPage: 108,
                firstQuestionIndex: 0,
                choiceRows: [...Array.from({ length: 54 }, (_, i) => [i + 4]), ...Array.from({ length: 54 }, (_, i) => [i + 4])],
                columns: [...Array<PayloadColumn>(54).fill(0), ...Array<PayloadColumn>(54).fill(1)],
            },
            {
                version: 4,
                totalPages: 1,
                pageNumber: 1,
                totalQuestions: 6,
                questionsOnPage: 6,
                firstQuestionIndex: 0,
                choiceRows: Array.from({ length: 6 }, (_, i) => Array.from({ length: 8 }, (_, j) => 4 + i * 8 + j)),
                columns: [0, 0, 0, 0, 0, 0],
            },
        ];
        for (const c of cases) expect(unpack(pack(c))).toEqual(c);
    });

    test("sizes: one column is 42 + 3q + 54 bits, two columns 42 + 4q + 108", () => {
        expect(payloadByteLength(0, false)).toBe(12);
        expect(payloadByteLength(37, false)).toBe(26);
        expect(payloadByteLength(38, false)).toBe(27);
        expect(payloadByteLength(14, true)).toBe(26);
        expect(payloadByteLength(15, true)).toBe(27);
    });

    test("fields are packed MSB-first in order: header, choice counts, row mask", () => {
        const bytes = pack({ version: 4, totalPages: 1, pageNumber: 1, totalQuestions: 1, questionsOnPage: 1, firstQuestionIndex: 0, choiceRows: [[4, 6]], columns: [0] });
        const bits = [...bytes].map((b) => b.toString(2).padStart(8, "0")).join("");
        const mask = "101" + "0".repeat(51);
        // 99 bits, padded to 104.
        expect(bits).toBe("0100" + "00001" + "00001" + "000000001" + "000000001" + "000000000" + "0" + "001" + mask + "00000");
    });

    test("two columns add a column bit per question and a second mask", () => {
        const bytes = pack({ version: 4, totalPages: 1, pageNumber: 1, totalQuestions: 2, questionsOnPage: 2, firstQuestionIndex: 0, choiceRows: [[10], [10, 11]], columns: [0, 1] });
        const bits = [...bytes].map((b) => b.toString(2).padStart(8, "0")).join("");
        const row = (rows: number[]) => Array.from({ length: 54 }, (_, i) => (rows.includes(i + 4) ? "1" : "0")).join("");
        const header = "0100" + "00001" + "00001" + "000000010" + "000000010" + "000000000" + "1";
        // 158 bits, padded to 160.
        expect(bits).toBe(header + "000" + "0" + "001" + "1" + row([10]) + row([10, 11]) + "00");
    });

    test("random round trips", () => {
        const rng = new Rng(99);
        for (let i = 0; i < 500; i++) {
            const totalQuestions = rng.int(1, 256);
            const firstQuestionIndex = rng.int(0, totalQuestions - 1);
            const want = rng.int(0, Math.min(20, totalQuestions - firstQuestionIndex));
            const two = rng.chance(0.5);
            const counts: number[] = [];
            const columns: PayloadColumn[] = [];
            const bubbles = [0, 0];
            while (counts.length < want) {
                const n = rng.int(1, 8);
                const col: PayloadColumn = two && rng.chance(0.5) ? 1 : 0;
                if (bubbles[col]! + n > MASK_ROWS) break;
                counts.push(n);
                columns.push(col);
                bubbles[col]! += n;
            }
            const rows = [sampleRows(rng, bubbles[0]!), sampleRows(rng, bubbles[1]!)];
            const at = [0, 0];
            const choiceRows = counts.map((n, q) => {
                const col = columns[q]!;
                return rows[col]!.slice(at[col], (at[col]! += n));
            });
            const totalPages = rng.int(1, 16);
            const p: PagePayload = {
                version: 4,
                totalPages,
                pageNumber: rng.int(1, totalPages),
                totalQuestions,
                questionsOnPage: counts.length,
                firstQuestionIndex,
                choiceRows,
                columns,
            };
            expect(unpack(pack(p))).toEqual(p);
        }
    });

    test("rejects an unknown version, and says when a sheet uses an older layout", () => {
        const bytes = pack(base);
        bytes[0] = (bytes[0]! & 0x0f) | 0x50;
        expect(() => unpack(bytes)).toThrow(/version 5/);
        bytes[0] = (bytes[0]! & 0x0f) | 0x30;
        expect(() => unpack(bytes)).toThrow(/older layout/);
    });

    test("rejects page 0 and pages past the total", () => {
        expect(() => pack({ ...base, pageNumber: 0 })).toThrow(PayloadError);
        // Hand-craft pageNumber 4 of 3, which pack refuses to write.
        const bytes = pack(base);
        // pageNumber occupies bits 9–13.
        const set = (bit: number, v: number) => {
            const mask = 0x80 >> (bit & 7);
            bytes[bit >> 3] = v ? bytes[bit >> 3]! | mask : bytes[bit >> 3]! & ~mask;
        };
        [0, 0, 1, 0, 0].forEach((v, i) => set(9 + i, v));
        expect(() => unpack(bytes)).toThrow(/pageNumber 4/);
        [0, 0, 0, 0, 0].forEach((v, i) => set(9 + i, v));
        expect(() => unpack(bytes)).toThrow(/pageNumber 0/);
    });

    test("rejects question ranges past the total", () => {
        expect(() => pack({ ...base, firstQuestionIndex: 38 })).toThrow(/exceed/);
    });

    test("rejects a byte length that doesn't match the bit count", () => {
        for (const p of [base, twoCol]) {
            const bytes = pack(p);
            expect(() => unpack(bytes.subarray(0, bytes.length - 1))).toThrow(/bytes/);
            expect(() => unpack(Uint8Array.from([...bytes, 0]))).toThrow(/bytes/);
        }
        expect(() => unpack(new Uint8Array(3))).toThrow(PayloadError);
    });

    test("rejects a row mask that doesn't match the choice counts", () => {
        const bytes = pack(base);
        // Clear the mask bit for row 11 (header 42 + 3 counts × 3 bits = bit 51, then row 11 → +7).
        const bit = 42 + 9 + 7;
        bytes[bit >> 3] = bytes[bit >> 3]! & ~(0x80 >> (bit & 7));
        expect(() => unpack(bytes)).toThrow(/12 bubble rows marked in column 0, expected 13/);
    });

    test("rejects bad rows, columns and choice counts", () => {
        expect(() => pack({ ...base, choiceRows: [[3, 12], [30], [57]] })).toThrow(/row/);
        expect(() => pack({ ...base, choiceRows: [[12], [30], [58]] })).toThrow(/row/);
        expect(() => pack({ ...base, choiceRows: [[12, 12], [30], [57]] })).toThrow(/increase/);
        expect(() => pack({ ...base, choiceRows: [[30], [12], [57]] })).toThrow(/increase/);
        expect(() => pack({ ...base, choiceRows: [[], [30], [57]] })).toThrow(/choice count/);
        expect(() => pack({ ...base, choiceRows: [Array.from({ length: 9 }, (_, i) => i + 4), [30], [57]] })).toThrow(/choice count/);
        expect(() => pack({ ...base, choiceRows: [[12], [30]] })).toThrow(/questions/);
        expect(() => pack({ ...base, columns: [0, 0] })).toThrow(/columns/);
        expect(() => pack({ ...base, columns: [0, 2 as PayloadColumn, 0] })).toThrow(/column 2/);
        // Rows only need to increase within a column.
        expect(() => pack({ ...twoCol, choiceRows: [[4, 5, 6, 7], [10, 11, 12], [15, 16, 17, 18], [8, 9, 13, 14, 15]] })).not.toThrow();
        expect(() => pack({ ...twoCol, choiceRows: [[4, 5, 6, 7], [10, 11, 12], [9, 16, 17, 18], [10, 11, 13, 14, 15]] })).toThrow(/increase/);
    });
});
