// Separate answer sheet mode: unscanned question pages, then an answer sheet of side-by-side
// bubbles with a version 5 QR payload.
import { describe, expect, test } from "bun:test";
import { unzipSync, zipSync } from "fflate";
import { ANSWER_FIRST_ROW, ANSWER_LAST_ROW, answerPayloadByteLength, pack, unpack, type PagePayload } from "../src/codec.ts";
import { LAYOUT, answerGridGeometry, answerRingRadius, colX, markerRect } from "../src/layout.ts";
import { layoutAnswerSheet, layoutBooklet, MAX_ANSWER_PAYLOAD_BYTES, measureQuestion, renderSeparate } from "../gen/booklet.ts";
import { capture } from "../gen/distort.ts";
import { makeFixture, type Fixture } from "../gen/fixture.ts";
import { Rng } from "../gen/rng.ts";
import { parseSheetJson } from "../gen/testdef.ts";
import { choiceKey, parseKey } from "../src/key.ts";
import type { NameReader } from "../src/ocr.ts";
import { processPage } from "../src/pipeline.ts";
import type { AnswerItem } from "../src/review.ts";
import { gradeZip } from "../src/run.ts";

const q = (prompt = "Which is true?", choices = ["a", "b", "c", "d"]) => ({ prompt, choices });

const answerPage = (counts: number[], rowsPerBlock: number, slots = Math.max(...counts)): PagePayload => ({
    version: 5,
    totalPages: 2,
    pageNumber: 2,
    totalQuestions: counts.length + 40,
    questionsOnPage: counts.length,
    firstQuestionIndex: 40,
    choiceRows: counts.map((n, k) => new Array<number>(n).fill(ANSWER_FIRST_ROW + (k % rowsPerBlock))),
    columns: counts.map(() => 0),
    answerGrid: { slots, rowsPerBlock },
});

describe("answer sheet payload", () => {
    test("round-trips pages with equal and with mixed choice counts", () => {
        const same = answerPage(new Array(120).fill(4), 30);
        expect(unpack(pack(same))).toEqual(same);
        // Equal counts encode as one run: a few bytes whatever the length.
        expect(pack(same).length).toBeLessThan(10);
        const rng = new Rng(9);
        const mixed = answerPage(Array.from({ length: 90 }, () => rng.int(1, 8)), 45, 8);
        expect(unpack(pack(mixed))).toEqual(mixed);
        expect(pack(mixed).length).toBe(answerPayloadByteLength(mixed.choiceRows.map((r) => r.length)));
    });

    test("still reads version 4 sheets", () => {
        const v4: PagePayload = { version: 4, totalPages: 1, pageNumber: 1, totalQuestions: 1, questionsOnPage: 1, firstQuestionIndex: 0, choiceRows: [[9, 10]], columns: [0] };
        expect(unpack(pack(v4))).toEqual(v4);
    });

    test("rejects inconsistent answer grids", () => {
        const p = answerPage([4, 4, 4], 5);
        expect(() => pack({ ...p, answerGrid: undefined })).toThrow(/answer grid/);
        expect(() => pack({ ...p, choiceRows: [[9, 9, 9, 9], [9, 9, 9, 9], [11, 11, 11, 11]] })).toThrow(/row 10/);
        expect(() => pack({ ...p, answerGrid: { slots: 3, rowsPerBlock: 5 } })).toThrow(/choice count/);
        expect(() => pack({ ...p, columns: [0, 1, 0] })).toThrow(/column/);
        expect(() => pack({ ...p, answerGrid: { slots: 4, rowsPerBlock: 50 } })).toThrow(/rowsPerBlock/);
        expect(() => unpack(pack(p).slice(0, 5))).toThrow();
    });
});

describe("answer sheet layout", () => {
    test("bubbles sit inside the page's columns, clear of the timing markers and of each other", () => {
        const r = answerRingRadius();
        expect(ANSWER_LAST_ROW).toBe(LAYOUT.bodyLastRow);
        for (let slots = 1; slots <= 8; slots++) {
            const g = answerGridGeometry(slots);
            expect(g.blocks).toBeGreaterThanOrEqual(3);
            const marker = markerRect(20);
            expect(g.bubbleX(0, 0) - r).toBeGreaterThan(marker.x + marker.w + LAYOUT.cellW);
            expect(g.blockX(0)).toBeGreaterThanOrEqual(colX(LAYOUT.answer.firstCol) - 0.01);
            expect(g.bubbleX(g.blocks - 1, slots - 1) + r).toBeLessThanOrEqual(colX(LAYOUT.answer.lastCol + 1));
            if (slots > 1) expect(g.bubbleX(0, 1) - g.bubbleX(0, 0)).toBeGreaterThan(2 * r + 5);
            if (g.blocks > 1) expect(g.blockX(1)).toBeGreaterThan(g.bubbleX(0, slots - 1) + r + 10);
        }
        // Rows are a cell apart: room between bubbles above and below.
        expect(LAYOUT.cellH - 2 * r).toBeGreaterThan(4);
    });

    test("numbers questions down each block in groups of five, and spreads a page's payload under the cap", () => {
        const [page] = layoutAnswerSheet({ title: "T", questions: Array.from({ length: 23 }, () => q()) });
        expect(page!.grid.rowsPerBlock! % 5).toBe(0);
        expect(page!.questions.map((x) => x.row).slice(0, page!.grid.rowsPerBlock! + 1)).toEqual([
            ...Array.from({ length: page!.grid.rowsPerBlock! }, (_, i) => ANSWER_FIRST_ROW + i),
            ANSWER_FIRST_ROW,
        ]);

        const rng = new Rng(3);
        const mixed = { title: "T", questions: Array.from({ length: 256 }, () => q("p", Array.from({ length: rng.int(2, 8) }, () => "x"))) };
        const pages = layoutAnswerSheet(mixed);
        expect(pages.flatMap((p) => p.questions.map((x) => x.index))).toEqual(mixed.questions.map((_, i) => i));
        for (const p of pages) expect(answerPayloadByteLength(p.questions.map((x) => x.centers.length))).toBeLessThanOrEqual(MAX_ANSWER_PAYLOAD_BYTES);

        // Equal counts are bounded only by the grid: 256 four-choice questions fit one page.
        expect(layoutAnswerSheet({ title: "T", questions: Array.from({ length: 256 }, () => q()) })).toHaveLength(1);
    });
});

describe("question pages", () => {
    test("short choices share lines, long ones stack", () => {
        const w = 340;
        expect(measureQuestion(q("p", ["1", "2", "3", "4"]), 0, w).perLine).toBe(4);
        expect(measureQuestion(q("p", ["A fairly long choice", "Another fairly long one", "A third", "A fourth"]), 0, w).perLine).toBe(2);
        const long = "This choice is long enough that it has to wrap onto a second line in a column";
        const m = measureQuestion(q("p", [long, "short"]), 0, w);
        expect(m.perLine).toBe(1);
        expect(m.choices[0]!.lines.length).toBe(2);
        expect(m.choices[1]!.dy - m.choices[0]!.dy).toBeGreaterThan(m.choices[0]!.lines.length * 13);
    });

    test("fill the left column, then the right, then the next page, never splitting a question", () => {
        const test_ = { title: "T", questions: Array.from({ length: 60 }, (_, i) => q(`Question ${i + 1} asks something`, ["one", "two", "three", "four"])) };
        const pages = layoutBooklet(test_);
        expect(pages.length).toBeGreaterThan(1);
        const order = pages.flatMap((p) => p.columns.flat().map((c) => c.question.index));
        expect(order).toEqual(test_.questions.map((_, i) => i));
        for (const p of pages) {
            for (const col of p.columns) {
                for (const [i, c] of col.entries()) {
                    if (i) expect(c.y).toBeGreaterThanOrEqual(col[i - 1]!.y + col[i - 1]!.question.height);
                    expect(c.y + c.question.height - 12).toBeLessThanOrEqual(1022.6);
                }
            }
        }
        // Far denser than the scanned format, which puts each choice on its own grid row.
        expect(pages.length).toBeLessThan(4);
    });

    test("question pages have no QR, markers or name field; the answer sheet follows them, numbered on", () => {
        const s = renderSeparate({ title: "Unit Test", questions: Array.from({ length: 30 }, () => q()) });
        for (const svg of s.questionPages) {
            expect(svg).not.toContain("crispEdges");
            expect(svg).not.toContain("Name (first and last)");
            expect(svg).toContain("Unit Test");
        }
        expect(s.questionPages[0]).toContain("answer sheet at the end");
        const total = s.questionPages.length + s.answerPages.length;
        const [a] = s.answerPages;
        expect(a!.svg).toContain("crispEdges");
        expect(a!.svg).toContain("Name (first and last)");
        expect(a!.svg).toContain(`Page ${s.questionPages.length + 1} of ${total}`);
        expect(unpack(pack(a!.payload))).toEqual(a!.payload);
        expect(a!.payload.totalPages).toBe(s.answerPages.length);
    });

    test("the parser checks the chosen mode's layout", () => {
        const long = "word ".repeat(140);
        const doc = JSON.stringify({ test: "T", questions: [{ prompt: long, choices: Array.from({ length: 8 }, () => long) }] });
        const sep = parseSheetJson(doc, { answerSheet: true });
        expect(sep.ok).toBe(false);
        if (!sep.ok) expect(sep.errors[0]!.message).toMatch(/one column of a question page/);

        // Many pages of questions are fine: only the answer sheet is limited to 16 pages.
        const many = JSON.stringify({ test: "T", questions: Array.from({ length: 256 }, () => ({ prompt: "word ".repeat(60), choices: ["a", "b", "c", "d"] })) });
        expect(parseSheetJson(many).ok).toBe(false);
        const r = parseSheetJson(many, { answerSheet: true });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.pageCount).toBeGreaterThan(16);
    });
});

function mockReader(fx: Fixture): NameReader {
    const byFile = new Map(fx.files.map((f) => [f.name, f.student]));
    return {
        async readName(_png, file) {
            const s = byFile.get(file);
            if (s === undefined || s < 0) throw new Error(`no student for ${file}`);
            return fx.students[s]!.name;
        },
    };
}

const keyFor = (fx: Fixture) => async (maxChoices: number[]) => {
    const parsed = parseKey(fx.key, maxChoices);
    if (!("key" in parsed)) throw new Error(parsed.error);
    return choiceKey(parsed.key);
};

describe("simulated answer sheets", () => {
    test(
        "reads every mark on every capture profile, across answer pages",
        async () => {
            const fx = await makeFixture({ seed: 61, students: 4, questions: 130, answerSheet: true });
            expect(Math.max(...fx.files.map((f) => f.pageNumber))).toBeGreaterThan(1);
            const entries = unzipSync(fx.zip);
            for (const f of fx.files) {
                const res = await processPage(f.name, entries[f.name]!);
                expect({ file: f.name, reasons: res.reasons }).toEqual({ file: f.name, reasons: [] });
                expect(res.payload!.answerGrid).toBeDefined();
                if (f.pageNumber === 1) expect(res.nameCrop).toBeDefined();
                for (const r of res.questions!) {
                    expect({ q: r.index, choices: r.choices }).toEqual({ q: r.index, choices: fx.dummy.test.questions[r.index]!.choices.length });
                    expect({ q: r.index, marked: r.marked }).toEqual({ q: r.index, marked: fx.students[f.student]!.responses[r.index]!.chosen });
                }
            }
        },
        300_000,
    );

    test(
        "grades submissions, skips problem ones, and frames review crops on the answer row",
        async () => {
            const fx = await makeFixture({ seed: 64, students: 5, questions: 110, answerSheet: true, ambiguousRate: 0.4, dropPageOf: 2 });
            expect(fx.students.filter((s, i) => s.hasAmbiguous && i !== 2).length).toBeGreaterThan(0);
            const result = await gradeZip(fx.zip, { nameReader: mockReader(fx), getKey: keyFor(fx) });
            expect(result.rows.map((r) => ({ name: r.name, score: r.score, total: r.total }))).toEqual(
                fx.expected.map((e) => ({ name: e.name, score: e.score, total: e.total })),
            );
            const skipped = result.skipped.map((s) => fx.files.find((f) => f.name === s.files[0])!.student);
            expect(skipped).toEqual(fx.expectedSkipped);
            expect(skipped).toContain(2);

            const items: AnswerItem[] = [];
            await gradeZip(fx.zip, {
                nameReader: mockReader(fx),
                getKey: keyFor(fx),
                review: {
                    async begin(list) {
                        for (const { item } of list) if (item.kind === "answer") items.push(item);
                    },
                    async ask() {
                        return { skip: true };
                    },
                },
            });
            expect(items.length).toBeGreaterThan(0);
            for (const it of items) {
                expect(new Set(it.rings.map((r) => Math.round(r.y))).size).toBe(1);
                for (const ring of it.rings) {
                    expect(ring.x - ring.r).toBeGreaterThan(0);
                    expect(ring.x + ring.r).toBeLessThan(it.width);
                    expect(ring.y - ring.r).toBeGreaterThan(0);
                    expect(ring.y + ring.r).toBeLessThan(it.height);
                }
            }
        },
        300_000,
    );

    test(
        "a question page scanned by mistake is flagged, not skipped silently",
        async () => {
            const fx = await makeFixture({ seed: 63, students: 2, questions: 12, answerSheet: true, profiles: ["scan"] });
            const s = renderSeparate(fx.dummy.test);
            const stray = await capture(s.questionPages[0]!, "scan", new Rng(1));
            const entries = unzipSync(fx.zip);
            const names = Object.keys(entries).sort();
            // After student 0's answer sheet, before student 1's.
            const zip = zipSync({ [names[0]!]: entries[names[0]!]!, "scans/page_001b.jpg": stray.bytes, [names[1]!]: entries[names[1]!]! }, { level: 0 });
            const result = await gradeZip(zip, { nameReader: mockReader(fx), getKey: keyFor(fx) });
            expect(result.rows.map((r) => r.name)).toEqual([fx.students[1]!.name]);
            expect(result.skipped).toHaveLength(1);
            expect(result.skipped[0]!.reasons.join(" ")).toMatch(/QR code not found/);
        },
        120_000,
    );
});
