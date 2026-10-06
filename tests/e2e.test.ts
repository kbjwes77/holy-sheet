// End to end on simulated sheets: generator → simulated pencil → distortion → zip → grader.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { unzipSync } from "fflate";
import { keyToString } from "../gen/dummy.ts";
import { makeFixture, type Fixture } from "../gen/fixture.ts";
import { main } from "../src/cli.ts";
import { choiceKey, parseKey } from "../src/key.ts";
import type { NameReader } from "../src/ocr.ts";
import { paginate } from "../gen/sheet.ts";
import { processPage } from "../src/pipeline.ts";
import type { AnswerItem } from "../src/review.ts";
import { gradeZip } from "../src/run.ts";

/** Mock OCR: answers with the simulated student's name for page-1 files. */
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

describe("synthetic sheets", () => {
    for (const profile of ["clean", "scan", "scan-flipped", "photo"] as const) {
        test(
            `decodes every mark (${profile})`,
            async () => {
                const fx = await makeFixture({ seed: 100 + profile.length, students: 2, questions: 18, profiles: [profile] });
                const entries = unzipSync(fx.zip);
                for (const f of fx.files) {
                    const res = await processPage(f.name, entries[f.name]!);
                    expect(res.reasons).toEqual([]);
                    for (const q of res.questions!) {
                        expect({ q: q.index, choices: q.choices }).toEqual({ q: q.index, choices: fx.dummy.test.questions[q.index]!.choices.length });
                        expect({ q: q.index, marked: q.marked }).toEqual({ q: q.index, marked: fx.students[f.student]!.responses[q.index]!.chosen });
                    }
                }
            },
            120_000,
        );
    }
});

describe("sheets with figures", () => {
    test(
        "figures between prompts and choices don't disturb reading any mark",
        async () => {
            const fx = await makeFixture({ seed: 11, students: 4, questions: 20, figureRate: 0.5 });
            expect(fx.dummy.test.questions.filter((q) => q.figures?.length).length).toBeGreaterThan(5);
            const entries = unzipSync(fx.zip);
            for (const f of fx.files) {
                const res = await processPage(f.name, entries[f.name]!);
                expect({ file: f.name, reasons: res.reasons }).toEqual({ file: f.name, reasons: [] });
                for (const q of res.questions!) {
                    expect({ q: q.index, marked: q.marked }).toEqual({ q: q.index, marked: fx.students[f.student]!.responses[q.index]!.chosen });
                }
            }
        },
        240_000,
    );
});

describe("two-column sheets", () => {
    test(
        "reads every mark in both columns, and review crops frame each question's bubbles",
        async () => {
            // Short choices put most questions in columns; every student also has one faint mark.
            const fx = await makeFixture({ seed: 34, students: 3, questions: 30, shortChoices: true, ambiguousRate: 1 });
            const columns = new Map(paginate(fx.dummy.test).flatMap((p) => p.questions.map((q) => [q.index, q.column] as const)));
            expect([...columns.values()].filter((c) => c === "right").length).toBeGreaterThan(10);
            const entries = unzipSync(fx.zip);
            for (const f of fx.files) {
                const res = await processPage(f.name, entries[f.name]!);
                expect({ file: f.name, reasons: res.reasons.filter((r) => !res.ambiguous?.includes(r)) }).toEqual({ file: f.name, reasons: [] });
                for (const q of res.questions!) {
                    expect({ q: q.index, column: q.column }).toEqual({ q: q.index, column: columns.get(q.index) === "right" ? 1 : 0 });
                    expect({ q: q.index, marked: q.marked }).toEqual({ q: q.index, marked: fx.students[f.student]!.responses[q.index]!.chosen });
                }
            }

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
            expect(items.some((it) => columns.get(it.question - 1) === "right")).toBe(true);
            for (const it of items) {
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
});

describe("end to end", () => {
    test(
        "grades valid submissions and skips problem ones",
        async () => {
            const fx = await makeFixture({ seed: 2024, students: 6, questions: 20, ambiguousRate: 0.25, dropPageOf: 4, orphan: true });
            const result = await gradeZip(fx.zip, { nameReader: mockReader(fx), getKey: keyFor(fx) });

            expect(result.rows.map((r) => ({ name: r.name, score: r.score, total: r.total }))).toEqual(
                fx.expected.map((e) => ({ name: e.name, score: e.score, total: e.total })),
            );
            const skippedStudents = result.skipped.filter((s) => !s.orphan).map((s) => fx.files.find((f) => f.name === s.files[0])!.student);
            expect(skippedStudents).toEqual(fx.expectedSkipped);
            expect(result.skipped.filter((s) => s.orphan)).toHaveLength(1);
            expect(fx.expectedSkipped).toContain(4); // the dropped-page submission
        },
        300_000,
    );

    test(
        "CLI writes CSV to stdout, prompts on stderr, re-prompts on a bad key, exits 2 on skips",
        async () => {
            const fx = await makeFixture({ seed: 77, students: 3, questions: 12, profiles: ["scan"], duplicatePageOf: 1 });
            const dir = mkdtempSync(join(tmpdir(), "grader-"));
            const zipPath = join(dir, "sheets.zip");
            writeFileSync(zipPath, fx.zip);
            let stdout = "";
            let stderr = "";
            const code = await main([zipPath], {
                nameReader: mockReader(fx),
                stdin: Readable.from(["A,B\n", keyToString(fx.dummy.key) + "\n"]),
                stdout: (s) => (stdout += s),
                stderr: (s) => (stderr += s),
            });
            expect(code).toBe(2);
            const expected = fx.expected.map((e) => `${e.name},${e.score},${e.total},${((e.score / e.total) * 100).toFixed(1)}\r\n`);
            expect(stdout).toBe("student_name,score,total,percent\r\n" + expected.join(""));
            expect(stderr).toContain("Answer key for 12 questions");
            expect(stderr).toMatch(/2 entries, but the test has 12 questions/);
            expect(stderr).toMatch(/duplicate page/);
            expect(stderr).toMatch(/graded 2, skipped 1 submission/);
            // Problem pages always get diagnostic images.
            const out = readdirSync(dir).find((d) => d.startsWith("grade-"));
            expect(out).toBeDefined();
            expect(readdirSync(join(dir, out!)).length).toBeGreaterThan(0);
        },
        300_000,
    );

    test("CLI fails fast without OpenRouter settings", async () => {
        let stderr = "";
        const code = await main(["missing.zip"], { env: {}, stderr: (s) => (stderr += s), stdout: () => {} });
        expect(code).toBe(1);
        expect(stderr).toMatch(/OPENROUTER_API_KEY and OPENROUTER_MODEL must be set/);
    });

    test("mixed tests are fatal", async () => {
        const a = await makeFixture({ seed: 5, students: 1, questions: 6, profiles: ["clean"] });
        const b = await makeFixture({ seed: 6, students: 1, questions: 7, profiles: ["clean"] });
        const { zipSync } = await import("fflate");
        const ea = unzipSync(a.zip);
        const eb = unzipSync(b.zip);
        const zip = zipSync({ ...Object.fromEntries(Object.entries(ea).map(([k, v]) => [`a/${k}`, v])), ...Object.fromEntries(Object.entries(eb).map(([k, v]) => [`b/${k}`, v])) });
        expect(gradeZip(zip, { nameReader: mockReader(a), getKey: keyFor(a) })).rejects.toThrow(/mixes tests/);
    }, 120_000);
});
