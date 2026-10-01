import { describe, expect, test } from "bun:test";
import { pack, payloadByteLength, unpack, PayloadError, type PagePayload } from "../src/codec.ts";
import { Rng } from "../gen/rng.ts";

const base: PagePayload = {
    version: 1,
    totalPages: 3,
    pageNumber: 2,
    totalQuestions: 40,
    questionsOnPage: 3,
    firstQuestionIndex: 10,
    rows: [12, 30, 57],
};

describe("codec", () => {
    test("round-trips a typical page", () => {
        expect(unpack(pack(base))).toEqual(base);
    });

    test("round-trips boundary values", () => {
        const cases: PagePayload[] = [
            { version: 1, totalPages: 1, pageNumber: 1, totalQuestions: 0, questionsOnPage: 0, firstQuestionIndex: 0, rows: [] },
            { version: 1, totalPages: 16, pageNumber: 16, totalQuestions: 256, questionsOnPage: 1, firstQuestionIndex: 255, rows: [60] },
            { version: 1, totalPages: 16, pageNumber: 1, totalQuestions: 256, questionsOnPage: 0, firstQuestionIndex: 255, rows: [] },
            {
                version: 1,
                totalPages: 1,
                pageNumber: 1,
                totalQuestions: 256,
                questionsOnPage: 256,
                firstQuestionIndex: 0,
                rows: Array.from({ length: 256 }, (_, i) => (i % 60) + 1),
            },
        ];
        for (const c of cases) expect(unpack(pack(c))).toEqual(c);
    });

    test("256 questions on one page is 1,577 bits = 198 bytes", () => {
        expect(payloadByteLength(256)).toBe(198);
    });

    test("header is packed MSB-first in field order", () => {
        const bytes = pack({ version: 1, totalPages: 1, pageNumber: 1, totalQuestions: 1, questionsOnPage: 1, firstQuestionIndex: 0, rows: [1] });
        // 0001 00001 00001 000000001 000000001 000000000 000000 + 1 pad bit = 48 bits
        const bits = [...bytes].map((b) => b.toString(2).padStart(8, "0")).join("");
        expect(bits).toBe("0001" + "00001" + "00001" + "000000001" + "000000001" + "000000000" + "000000" + "0");
    });

    test("random round trips", () => {
        const rng = new Rng(99);
        for (let i = 0; i < 500; i++) {
            const totalQuestions = rng.int(1, 256);
            const firstQuestionIndex = rng.int(0, totalQuestions - 1);
            const questionsOnPage = rng.int(0, totalQuestions - firstQuestionIndex);
            const totalPages = rng.int(1, 16);
            const p: PagePayload = {
                version: 1,
                totalPages,
                pageNumber: rng.int(1, totalPages),
                totalQuestions,
                questionsOnPage,
                firstQuestionIndex,
                rows: Array.from({ length: questionsOnPage }, () => rng.int(1, 60)),
            };
            expect(unpack(pack(p))).toEqual(p);
        }
    });

    test("rejects an unknown version", () => {
        const bytes = pack(base);
        bytes[0] = (bytes[0]! & 0x0f) | 0x20;
        expect(() => unpack(bytes)).toThrow(/version/);
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
        const bytes = pack(base);
        expect(() => unpack(bytes.subarray(0, bytes.length - 1))).toThrow(/bytes/);
        expect(() => unpack(Uint8Array.from([...bytes, 0]))).toThrow(/bytes/);
        expect(() => unpack(new Uint8Array(3))).toThrow(PayloadError);
    });

    test("rejects rows outside 1–60", () => {
        expect(() => pack({ ...base, rows: [0, 30, 57] })).toThrow(/row/);
        expect(() => pack({ ...base, rows: [12, 30, 61] })).toThrow(/row/);
    });
});
