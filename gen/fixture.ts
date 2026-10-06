// Builds a zip of simulated student submissions with known expected results.
import { zipSync } from "fflate";
import { capture, type Profile } from "./distort.ts";
import { renderSeparate } from "./booklet.ts";
import type { GradingKey } from "../src/key.ts";
import { answerSheetOverlay, dummyGradingKey, expectedScore, keyToString, makeDummyTest, makeStudent, studentOverlay, totalPoints, type DummyTest, type SimStudent } from "./dummy.ts";
import { Rng } from "./rng.ts";
import { renderTest } from "./sheet.ts";

export interface FixtureOptions {
    seed: number;
    students: number;
    questions: number;
    profiles?: Profile[];
    /** Per-sheet probability of an ambiguous mark. */
    ambiguousRate?: number;
    /** Drop page 2 of this submission (0-based student index). */
    dropPageOf?: number;
    /** Put a stray non-first page before the first submission. */
    orphan?: boolean;
    /** Duplicate a page of this submission. */
    duplicatePageOf?: number;
    /** Chance each question shows figures (graphs, tables) between its prompt and choices. */
    figureRate?: number;
    /** Choices of a word or two, so most questions print in two columns. */
    shortChoices?: boolean;
    /** Chance each question is free response (a handwritten answer in a box). */
    freeRate?: number;
    /** Print a separate answer sheet; only its pages are scanned into the zip. */
    answerSheet?: boolean;
}

export interface FixtureFile {
    name: string;
    student: number;
    pageNumber: number;
    profile: Profile;
}

export interface Fixture {
    zip: Uint8Array;
    dummy: DummyTest;
    /** The letter key line (multiple-choice tests only). */
    key: string;
    /** The key as the grader takes it from a test JSON, with free-response answers and points. */
    grading: GradingKey;
    students: SimStudent[];
    files: FixtureFile[];
    /** Expected CSV rows (student_name, score, total, percent) for submissions that should grade. */
    expected: { student: number; name: string; score: number; total: number }[];
    /** Students whose submissions should be skipped. */
    expectedSkipped: number[];
}

export async function makeFixture(o: FixtureOptions): Promise<Fixture> {
    const rng = new Rng(o.seed);
    const dummy = makeDummyTest(rng, o.questions, undefined, o.figureRate, o.shortChoices, o.freeRate);
    const profiles = o.profiles ?? ["clean", "scan", "scan-flipped", "photo"];
    const entries: Record<string, Uint8Array> = {};
    const files: FixtureFile[] = [];
    const students: SimStudent[] = [];
    let counter = 0;
    const add = (bytes: Uint8Array, ext: string, meta: Omit<FixtureFile, "name">) => {
        const name = `scans/page_${String(++counter).padStart(3, "0")}.${ext}`;
        entries[name] = bytes;
        files.push({ name, ...meta });
    };

    const pageSets: { student: number; pageNumber: number; svg: string }[][] = [];
    for (let s = 0; s < o.students; s++) {
        const student = makeStudent(rng, dummy, { ability: rng.range(0.4, 0.95), ambiguousRate: o.ambiguousRate ?? 0 });
        students.push(student);
        const pages = o.answerSheet
            ? renderSeparate(dummy.test, { overlay: (page) => answerSheetOverlay(student, page, rng) }).answerPages
            : renderTest(dummy.test, { overlay: (page) => studentOverlay(student, dummy, page, rng) });
        pageSets.push(pages.map((p) => ({ student: s, pageNumber: p.page.pageNumber, svg: p.svg })));
    }

    if (o.orphan && pageSets[0] && pageSets[0].length > 1) {
        const p = pageSets[0][1]!;
        const c = await capture(p.svg, "clean", rng);
        add(c.bytes, c.ext, { student: -1, pageNumber: p.pageNumber, profile: "clean" });
    }
    for (const [s, pages] of pageSets.entries()) {
        let list = pages;
        if (o.dropPageOf === s && pages.length > 1) list = pages.filter((p) => p.pageNumber !== 2);
        if (o.duplicatePageOf === s) list = [...pages, pages.at(-1)!];
        for (const p of list) {
            const profile = rng.pick(profiles);
            const c = await capture(p.svg, profile, rng);
            add(c.bytes, c.ext, { student: s, pageNumber: p.pageNumber, profile });
        }
    }

    const skipped = new Set<number>();
    students.forEach((st, i) => st.hasAmbiguous && skipped.add(i));
    if (o.dropPageOf !== undefined && pageSets[o.dropPageOf]!.length > 1) skipped.add(o.dropPageOf);
    if (o.duplicatePageOf !== undefined) skipped.add(o.duplicatePageOf);

    return {
        zip: zipSync(entries, { level: 0 }),
        dummy,
        key: keyToString(dummy.key),
        grading: dummyGradingKey(dummy),
        students,
        files,
        expected: students.flatMap((st, i) =>
            skipped.has(i) ? [] : [{ student: i, name: st.name, score: expectedScore(st, dummy), total: totalPoints(dummy) }],
        ),
        expectedSkipped: [...skipped].sort((a, b) => a - b),
    };
}
