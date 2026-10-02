import { describe, expect, test } from "bun:test";
import { truncate, textWidth, wrapWidth } from "../gen/textwidth.ts";
import { parseSheetJson, type ParseResult } from "../gen/testdef.ts";
import { MAX_PAYLOAD_BYTES, renderTest, titleLayout, type RenderedPage } from "../gen/sheet.ts";
import { pack } from "../src/codec.ts";
import { LAYOUT, colX, rangeRect, rowY, textRightEdge } from "../src/layout.ts";

const q = (prompt = "What is 2 + 2?", choices = ["3", "4", "5"], extra: object = {}) => ({ prompt, choices, ...extra });
const doc = (o: unknown) => JSON.stringify(o);

function errors(r: ParseResult): string[] {
    if (r.ok) throw new Error("expected validation to fail");
    return r.errors.map((e) => `${e.path}: ${e.message}`);
}

describe("parseSheetJson", () => {
    test("accepts the example file and reports pages, no key", async () => {
        const text = await Bun.file(new URL("../examples/ap-macro-unit-4.json", import.meta.url)).text();
        const r = parseSheetJson(text);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.test.questions).toHaveLength(10);
        expect(r.key).toBeNull();
        expect(r.pageCount).toBeGreaterThanOrEqual(1);
    });

    test("builds the grader key from answers, normalising case and order", () => {
        const r = parseSheetJson(doc({ test: "T", questions: [q(undefined, undefined, { answer: "b" }), q(undefined, undefined, { answer: "ca" })] }));
        expect(r.ok && r.key).toBe("B,AC");
    });

    test("reports a syntax error", () => {
        const e = errors(parseSheetJson(`{ "test": "T", "questions": [ { "prompt": "x", "choices: ["a","b"] } ] }`));
        expect(e).toHaveLength(1);
        expect(e[0]).toStartWith(": ");
    });

    test("empty input and non-object documents", () => {
        expect(errors(parseSheetJson("  "))[0]).toContain("Paste");
        expect(errors(parseSheetJson("[]"))[0]).toContain("got an array");
    });

    test("collects every problem with its path", () => {
        const e = errors(
            parseSheetJson(
                doc({
                    title: "T",
                    questions: [
                        q("", ["a"]),
                        { prompt: "p", options: ["a", "b"] },
                        q("p", ["a", "", 3] as unknown as string[]),
                        q("p", ["a", "b"], { answer: "C" }),
                        "nope",
                    ],
                }),
            ),
        );
        expect(e).toContain(`title: Unknown key "title". Did you mean "test"?`);
        expect(e).toContain(`test: Missing "test" (the test name).`);
        expect(e).toContain("questions[0].prompt: Must not be empty.");
        expect(e).toContain("questions[0].choices: Expected 2–8 choices, got 1.");
        expect(e).toContain(`questions[1].options: Unknown key "options". Did you mean "choices"?`);
        expect(e).toContain(`questions[1].choices: Missing "choices".`);
        expect(e).toContain("questions[2].choices[1]: Must not be empty.");
        expect(e).toContain("questions[2].choices[2]: Expected text, got a number.");
        expect(e).toContain(`questions[3].answer: "C" is not a choice (this question has A–B).`);
        expect(e).toContain(`questions[4]: Expected an object with "prompt" and "choices", got a string.`);
        expect(e.some((s) => s.startsWith("questions[].answer:") && s.includes("Missing: 1, 2, 3, 5"))).toBe(true);
    });

    test("question count and choice count limits", () => {
        expect(errors(parseSheetJson(doc({ test: "T", questions: [] })))[0]).toContain("at least 1");
        expect(errors(parseSheetJson(doc({ test: "T", questions: Array.from({ length: 257 }, () => q()) })))[0]).toContain("max 256");
        const nine = "ABCDEFGHI".split("");
        expect(errors(parseSheetJson(doc({ test: "T", questions: [q("p", nine)] })))[0]).toContain("got 9");
        expect(parseSheetJson(doc({ test: "T", questions: [q("p", nine.slice(0, 8), { answer: "H" })] })).ok).toBe(true);
    });

    test("bad answers", () => {
        const e = errors(
            parseSheetJson(doc({ test: "T", questions: [q("p", ["a", "b"], { answer: "A B" }), q("p", ["a", "b"], { answer: "AA" }), q("p", ["a", "b"], { answer: 1 })] })),
        );
        expect(e[0]).toContain(`Expected choice letters`);
        expect(e[1]).toContain("Repeats a letter");
        expect(e[2]).toContain("got a number");
    });

    test("rejects characters the PDF font can't draw, allows curly quotes and accents", () => {
        expect(parseSheetJson(doc({ test: "Café “quiz” — 1…", questions: [q()] })).ok).toBe(true);
        expect(errors(parseSheetJson(doc({ test: "T 😀", questions: [q()] })))[0]).toContain("U+1F600");
    });

    test("too many pages", () => {
        const long = "word ".repeat(150);
        const e = errors(parseSheetJson(doc({ test: "T", questions: Array.from({ length: 256 }, () => q(long, ["a", "b", "c", "d"])) })));
        expect(e[0]).toContain("at most 16");
    });
});

describe("renderer text fitting", () => {
    test("truncate adds an ellipsis only when needed", () => {
        expect(truncate("Short", 100, 11)).toBe("Short");
        const t = truncate("AP Macroeconomics Unit 4: The Financial Sector - Bonds and Interest Rates", 290, 11);
        expect(t.endsWith("…")).toBe(true);
        expect(textWidth(t, 11)).toBeLessThanOrEqual(290);
    });

    test("title fits two rows above the fields (page 1 only), shrinking to wrap, then truncates; footer has the name and page", () => {
        const width = rangeRect(LAYOUT.titleArea).w;
        expect(titleLayout("Unit 4 Quiz", width)).toEqual({ lines: ["Unit 4 Quiz"], size: 16 });
        const title = "AP Macroeconomics Unit 4 Review: Financial Sector, Money Markets, Loanable Funds and Monetary Policy";
        const wrapped = titleLayout(title, width);
        expect(wrapped.lines).toHaveLength(2);
        expect(wrapped.lines.join(" ")).toBe(title);
        expect(wrapped.size).toBeLessThan(16);
        // Two lines and their descenders stay inside the title area's two rows.
        expect(wrapped.size * 1.2 + wrapped.size + 3).toBeLessThanOrEqual(2 * LAYOUT.cellH);
        const pages = renderTest({ title, questions: Array.from({ length: 30 }, () => q()) });
        expect(pages.length).toBeGreaterThan(1);
        for (const p of pages) {
            for (const line of wrapped.lines) {
                expect(p.svg.includes(`font-size="${wrapped.size}" font-weight="bold">${line}</text>`)).toBe(p.page.pageNumber === 1);
            }
            expect(p.svg.includes("Name (first and last)")).toBe(p.page.pageNumber === 1);
            expect(p.svg).toContain(`fill="#555">${title}</text>`);
            expect(p.svg).toContain(`>Page ${p.page.pageNumber} of ${pages.length}</text>`);
        }
        const long = titleLayout("Word ".repeat(60).trim(), width);
        expect(long.size).toBe(10);
        expect(long.lines).toHaveLength(2);
        expect(long.lines[1]!.endsWith("…")).toBe(true);
    });

    test("each choice gets its own bubble row; long choices wrap onto the rows below", () => {
        const short = renderTest({ title: "T", questions: [q("p", ["1", "2", "3", "4"])] })[0]!;
        const sq = short.page.questions[0]!;
        expect(sq.choices.map((c) => c.row)).toEqual([sq.promptRow + 1, sq.promptRow + 2, sq.promptRow + 3, sq.promptRow + 4]);
        expect(short.payload.choiceRows).toEqual([sq.choices.map((c) => c.row)]);
        const long = "a very long choice that keeps going ".repeat(6);
        const placed = renderTest({ title: "T", questions: [q("p", [long, "short"])] })[0]!.page.questions[0]!;
        expect(placed.choices[0]!.lines.length).toBeGreaterThan(1);
        expect(placed.choices[1]!.row).toBe(placed.choices[0]!.row + placed.choices[0]!.lines.length);
        expect(placed.choices[1]!.lines).toEqual(["short"]);
    });

    test("question numbers print on a dark rectangle inside their prompt row, the prompt indented beside them, its first line on a light one", () => {
        const pages = renderTest({ title: "T", questions: Array.from({ length: 12 }, (_, i) => q(`Prompt ${i + 1}`, ["a", "b"])) });
        const rects = [...pages.map((p) => p.svg).join("").matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="#222222"\/>/g)].map((m) =>
            m.slice(1).map(Number),
        );
        expect(rects).toHaveLength(12);
        const widths = new Set(rects.map((r) => r[2]));
        expect(widths.size).toBe(1); // 1–9 and 10–12 share a width
        const pq = pages[0]!.page.questions[0]!;
        expect(pq.promptLines).toEqual(["Prompt 1"]);
        const [x, y, w, h] = rects[0]!;
        expect(x).toBe(+colX(LAYOUT.promptCol).toFixed(2));
        expect(y!).toBeGreaterThan(rowY(pq.promptRow));
        expect(y! + h!).toBeLessThan(rowY(pq.promptRow + 1));
        // Ends left of the bubbles' ring edge, as well as above the row the first bubble is on.
        expect(x! + w!).toBeLessThan(colX(LAYOUT.ring.col + 1) - LAYOUT.cellW / 2 - LAYOUT.cellW * 0.6 * 0.5);
        expect(pages[0]!.svg).toContain(`fill="#FFFFFF">1</text>`);
        // The first prompt line's light grey rectangle continues from the number's to past the text.
        const bar = pages[0]!.svg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="#eeeeee"\/>/)!.slice(1).map(Number);
        expect(bar[0]).toBeCloseTo(x! + w!, 1);
        expect([bar[1], bar[3]]).toEqual([y, h]);
        expect(bar[0]! + bar[2]!).toBeGreaterThan(x! + w! + 5 + textWidth("Prompt 1", 11, true));
        expect(pages[0]!.svg).toMatch(/>Prompt 1<\/text>/);
    });

    test("page 1 starts a row below the instructions, later pages at the top; questions never split across pages", () => {
        const pages = renderTest({ title: "T", questions: Array.from({ length: 40 }, () => q("p", ["a", "b", "c", "d", "e"])) });
        expect(pages[0]!.svg).toContain("Fill in the bubble next to every correct answer");
        expect(pages[1]!.svg).not.toContain("Fill in the bubble");
        expect(pages[0]!.page.questions[0]!.promptRow).toBe(LAYOUT.instructionsRow + 2);
        // Later pages have no title or fields: the first choice lands on the first bubble row under
        // the corner square, its one-line prompt beside the square.
        const first = pages[1]!.page.questions[0]!;
        expect(first.choices[0]!.row).toBe(LAYOUT.firstRowContinued);
        expect(first.promptRow).toBe(LAYOUT.firstRowContinued - 1);
        // Only the first question rises; the next starts a blank row after it.
        expect(pages[1]!.page.questions[1]!.promptRow).toBe(first.choices.at(-1)!.row + 2);
        expect(pages[1]!.svg).not.toContain("Name (first and last)");
        for (const p of pages)
            for (const pq of p.page.questions) {
                const last = pq.choices.at(-1)!;
                expect(last.row + last.lines.length - 1).toBeLessThanOrEqual(57);
            }
    });

    test("beside the QR, lines wrap short of it, then use the full width from row 10", () => {
        // A choice that fits on one full-width line but not beside the QR.
        const x = colX(LAYOUT.ring.col + 1) + 4 + 16;
        let long = "word";
        while (textWidth(long, 11) < textRightEdge(LAYOUT.qrClearRow - 1) - x + 40) long += " word";
        expect(textWidth(long, 11)).toBeLessThan(textRightEdge(LAYOUT.qrClearRow) - x);
        const pages = renderTest({ title: "T", questions: Array.from({ length: 16 }, () => q("Which statement is true?", [long, long, long, long])) });
        const top = pages[1]!.page.questions[0]!;
        expect(top.choices[0]!.row).toBe(LAYOUT.firstRowContinued);
        const rows = top.choices.flatMap((c) => c.lines.map((line, k) => ({ row: c.row + k, line })));
        expect(rows.some((r) => r.row < LAYOUT.qrClearRow)).toBe(true);
        expect(rows.some((r) => r.row >= LAYOUT.qrClearRow)).toBe(true);
        for (const { row, line } of rows) expect(textWidth(line, 11)).toBeLessThanOrEqual(textRightEdge(row) - x);
        expect(textRightEdge(LAYOUT.qrClearRow - 1)).toBeLessThanOrEqual(colX(LAYOUT.qrArea.col1));
        // The same question wraps to fewer lines when it starts below the QR.
        const first = pages[0]!.page.questions[0]!;
        const lineCount = (pq: typeof top) => pq.choices.reduce((n, c) => n + c.lines.length, 0);
        expect(lineCount(first)).toBeLessThan(lineCount(top));
    });

    test("a page 2+ question that won't fit even from row 4 is an error", () => {
        expect(() => renderTest({ title: "T", questions: [q("p", Array.from({ length: 8 }, () => "word ".repeat(150)))] })).toThrow(/too long/);
    });

    test("wrapWidth: per-line widths", () => {
        expect(wrapWidth("aa bb cc dd", (i) => (i === 0 ? textWidth("aa", 11) : 1000), 11)).toEqual(["aa", "bb cc dd"]);
    });
});

describe("two-column layout", () => {
    const C = LAYOUT.columns;
    /** A choice that fits one full-width line but wraps in a column. */
    let wide = "word";
    while (textWidth(wide, 11) < 320) wide += " word";
    const wideQ = () => q("Which statement is true?", [wide, "short", "short"]);
    const columnsOf = (p: RenderedPage) => p.page.questions.map((pq) => pq.column);

    test("short-choice questions fill the left column, then the right, with a divider between", () => {
        const [page, ...rest] = renderTest({ title: "T", questions: Array.from({ length: 12 }, () => q()) });
        expect(rest).toHaveLength(0);
        const cols = columnsOf(page!);
        const split = cols.indexOf("right");
        expect(split).toBeGreaterThan(0);
        expect(cols).toEqual([...Array(split).fill("left"), ...Array(12 - split).fill("right")]);
        expect(page!.page.questions.map((pq) => pq.index)).toEqual(Array.from({ length: 12 }, (_, i) => i));
        expect(page!.payload.columns).toEqual(cols.map((c) => (c === "right" ? 1 : 0)));
        // Both columns start level, below the QR; they come out within one question of each other.
        const right = page!.page.questions.filter((pq) => pq.column === "right");
        const left = page!.page.questions.filter((pq) => pq.column === "left");
        expect(left[0]!.promptRow).toBe(LAYOUT.firstRowPage1);
        expect(right[0]!.promptRow).toBe(LAYOUT.firstRowPage1);
        const end = (pq: (typeof left)[number]) => pq.choices.at(-1)!.row + 1;
        expect(Math.abs(end(left.at(-1)!) - end(right.at(-1)!))).toBeLessThanOrEqual(5);
        // Bubbles sit in each column's own bubble column.
        const x = colX(C.right.ringCol) + LAYOUT.cellW / 2;
        expect(page!.svg).toContain(`<circle cx="${+x.toFixed(2)}"`);
        expect(page!.page.dividers).toEqual([{ fromRow: LAYOUT.firstRowPage1, toRow: Math.max(end(left.at(-1)!), end(right.at(-1)!)) }]);
        expect(page!.svg).toContain(`<line x1="${+(colX(C.dividerCol) + LAYOUT.cellW / 2).toFixed(2)}"`);
    });

    test("a question whose choices would wrap in a column prints full width, with a section break below the columns", () => {
        const end = (pq: { choices: { row: number; lines: string[] }[] }) => pq.choices.at(-1)!.row + pq.choices.at(-1)!.lines.length;
        // Full width first, then the usual blank row and the columns, with no hairline.
        const top = renderTest({ title: "T", questions: [wideQ(), q(), q(), q()] });
        expect(top).toHaveLength(1);
        expect(columnsOf(top[0]!)).toEqual(["full", "left", "left", "right"]);
        const full = top[0]!.page.questions[0]!;
        expect(top[0]!.page.sectionBreaks).toEqual([]);
        expect(top[0]!.page.questions[1]!.promptRow).toBe(end(full) + 1);
        // After the columns, the same break, then every remaining question full width.
        const after = renderTest({ title: "T", questions: [q(), q(), q(), wideQ(), q(), q()] });
        expect(after.map(columnsOf)).toEqual([["left", "left", "right", "full", "full", "full"]]);
        const page = after[0]!.page;
        expect(page.sectionBreaks).toEqual([page.dividers[0]!.toRow + 1]);
        expect(page.questions[3]!.promptRow).toBe(page.dividers[0]!.toRow + 2);
        expect(after[0]!.payload.columns).toEqual([0, 0, 1, 0, 0, 0]);
        expect(after[0]!.svg).toContain(`y1="${+rowY(page.sectionBreaks[0]!).toFixed(2)}" x2=`);
        // Full width, columns, full width: only the switch below the columns gets a break.
        const both = renderTest({ title: "T", questions: [wideQ(), q(), q(), q(), wideQ()] });
        expect(both.map(columnsOf)).toEqual([["full", "left", "left", "right", "full"]]);
        expect(both[0]!.page.sectionBreaks).toEqual([both[0]!.page.dividers[0]!.toRow + 1]);
    });

    test("a full-width question that won't fit below the columns starts the next page", () => {
        const tall = () => q("Which is true?", ["a", "b", "c", "d", "e", "f"]);
        const long = q("Which statement is true?", [wide, ...Array.from({ length: 7 }, () => "short")]);
        const pages = renderTest({ title: "T", questions: [...Array.from({ length: 10 }, tall), long] });
        expect(pages).toHaveLength(2);
        expect(pages[0]!.page.sectionBreaks).toEqual([]);
        expect(pages[0]!.page.questions.every((pq) => pq.column !== "full")).toBe(true);
        expect(pages[1]!.page.questions[0]!.choices[0]!.row).toBe(LAYOUT.firstRowContinued);
        // It needed more than the rows left after the band and its section break.
        const p2 = pages[1]!.page.questions[0]!;
        const rows = p2.choices.at(-1)!.row + 1 - p2.promptRow;
        expect(pages[0]!.page.dividers[0]!.toRow + 2 + rows - 1).toBeGreaterThan(LAYOUT.bodyLastRow);
    });

    test("a column question with no other beside it prints full width", () => {
        expect(columnsOf(renderTest({ title: "T", questions: [q()] })[0]!)).toEqual(["full"]);
        expect(columnsOf(renderTest({ title: "T", questions: [wideQ(), q()] })[0]!)).toEqual(["full", "full"]);
        expect(renderTest({ title: "T", questions: [q()] })[0]!.page.dividers).toEqual([]);
    });

    test("a two-column page closes at 14 questions, so its QR stays at version 2", () => {
        const pages = renderTest({ title: "T", questions: Array.from({ length: 40 }, () => q("p", ["a", "b"])) });
        expect(pages[0]!.page.questions).toHaveLength(14);
        for (const p of pages) {
            expect(pack(p.payload).length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
            expect(p.page.questions.length).toBeLessThanOrEqual(14);
        }
        // Later pages: the left column's first choice is on the first bubble row, the right column starts below the QR.
        const second = pages[1]!.page.questions;
        expect(second.find((pq) => pq.column === "left")!.choices[0]!.row).toBe(LAYOUT.firstRowContinued);
        expect(second.find((pq) => pq.column === "right")!.promptRow).toBe(LAYOUT.qrClearRow);
    });
});
