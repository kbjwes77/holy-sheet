// Dummy tests with answer keys, and simulated students who fill them in.
import { CHOICE_LETTERS, LAYOUT, rangeRect, ringCenters, ringRadius, colX, rowY } from "../src/layout.ts";
import { handwriting, markSvg, strayMark, type MarkStyle } from "./pencil.ts";
import type { Rng } from "./rng.ts";
import type { PageLayout, TestDef } from "./sheet.ts";

export interface DummyTest {
    test: TestDef;
    /** Correct choice indexes per question. */
    key: number[][];
}

const SUBJECTS = ["photosynthesis", "the water cycle", "plate tectonics", "the French Revolution", "linear equations", "cell division", "supply and demand", "the Pythagorean theorem", "chemical bonding", "the Bill of Rights", "Newton's laws", "ecosystems", "the Industrial Revolution", "probability", "figurative language"];
const STEMS = [
    "Which statement best describes {s}?",
    "Which of the following is an example of {s}?",
    "What is the main cause of {s}?",
    "Which conclusion about {s} is supported by the passage?",
    "Select all statements about {s} that are true.",
    "A student is studying {s}. Which observation would best support the hypothesis described in the lab notes above?",
];
const WORDS = ["energy", "pressure", "the government", "a reaction", "the slope", "temperature", "the author", "the market", "a force", "the population", "a ratio", "the cell", "the treaty", "the solution", "a variable"];

function choiceText(rng: Rng): string {
    const n = rng.int(1, 5);
    return Array.from({ length: n }, () => rng.pick(WORDS)).join(" and ").replace(/^./, (c) => c.toUpperCase());
}

/** Mostly 4–5 choices, some true/false, a few wide (6–8) and single-ring questions. */
function choiceCount(rng: Rng): number {
    const r = rng.next();
    if (r < 0.1) return 2;
    if (r < 0.5) return 4;
    if (r < 0.8) return 5;
    if (r < 0.87) return 3;
    if (r < 0.92) return 6;
    if (r < 0.95) return 7;
    if (r < 0.98) return 8;
    return 1;
}

export function makeDummyTest(rng: Rng, questionCount: number, title = "Unit 4 Quiz"): DummyTest {
    const key: number[][] = [];
    const questions = Array.from({ length: questionCount }, () => {
        const n = choiceCount(rng);
        const stem = rng.pick(STEMS).replace("{s}", rng.pick(SUBJECTS));
        const multi = stem.startsWith("Select all") && n >= 3;
        let answer = [rng.int(0, n - 1)];
        if (multi) {
            const set = new Set(answer);
            while (set.size < Math.min(n, rng.int(2, 3))) set.add(rng.int(0, n - 1));
            answer = [...set].sort((a, b) => a - b);
        }
        key.push(answer);
        return { prompt: stem, choices: Array.from({ length: n }, () => choiceText(rng)) };
    });
    return { test: { title, questions }, key };
}

export function keyToString(key: number[][]): string {
    return key.map((k) => k.map((i) => CHOICE_LETTERS[i]).join("")).join(",");
}

export interface Response {
    /** Choices that are meant to be read as marked. */
    chosen: number[];
    /** Drawn marks per choice index (chosen and otherwise). */
    marks: Map<number, MarkStyle>;
}

export interface SimStudent {
    name: string;
    period: string;
    date: string;
    testName: string;
    responses: Response[];
    /** True if the sheet contains a mark that should be read as ambiguous. */
    hasAmbiguous: boolean;
}

const FIRST = ["Jane", "Marcus", "Priya", "Liam", "Sofia", "Ethan", "Aisha", "Noah", "Mei", "Diego", "Olivia", "Kwame", "Hannah", "Mateo", "Zoe", "Ravi"];
const LAST = ["Doe", "Johnson", "Patel", "Nguyen", "Garcia", "O'Brien", "Kowalski", "Okafor", "Chen", "Rivera", "Smith", "Haddad", "Larsen", "Fischer"];

export interface StudentOptions {
    /** Probability of answering a question correctly. */
    ability: number;
    /** Probability per question of leaving it blank. */
    blankRate?: number;
    /** Probability per sheet of including one ambiguous (partial/light) mark. */
    ambiguousRate?: number;
}

const GOOD_STYLES: MarkStyle[] = ["solid", "solid", "solid", "sloppy", "scribble"];

export function makeStudent(rng: Rng, dummy: DummyTest, opts: StudentOptions): SimStudent {
    const responses: Response[] = dummy.test.questions.map((q, qi) => {
        const n = q.choices.length;
        const marks = new Map<number, MarkStyle>();
        let chosen: number[];
        if (rng.chance(opts.blankRate ?? 0.03)) chosen = [];
        else if (rng.chance(opts.ability)) chosen = [...dummy.key[qi]!];
        else {
            chosen = [rng.int(0, n - 1)];
            if (dummy.key[qi]!.length > 1 && rng.chance(0.5)) chosen = dummy.key[qi]!.slice(0, 1); // partial multi-select
        }
        for (const c of chosen) marks.set(c, rng.pick(GOOD_STYLES));
        // A changed answer: an erased mark on another choice.
        if (n > 1 && rng.chance(0.06)) {
            const other = rng.int(0, n - 1);
            if (!marks.has(other)) marks.set(other, "erased");
        }
        return { chosen: chosen.sort((a, b) => a - b), marks };
    });
    let hasAmbiguous = false;
    if (rng.chance(opts.ambiguousRate ?? 0)) {
        const r = rng.pick(responses.filter((r) => r.marks.size < 8));
        const n = dummy.test.questions[responses.indexOf(r)]!.choices.length;
        const free = Array.from({ length: n }, (_, i) => i).filter((i) => !r.marks.has(i));
        if (free.length) {
            // Only uniform faint marks: partial shading straddles the thresholds by nature, so it
            // isn't reliable ground truth for "should read ambiguous".
            r.marks.set(rng.pick(free), "light");
            hasAmbiguous = true;
        }
    }
    return {
        name: `${rng.pick(FIRST)} ${rng.pick(LAST)}`,
        period: String(rng.int(1, 8)),
        date: `09/${String(rng.int(1, 30)).padStart(2, "0")}/26`,
        testName: dummy.test.title,
        responses,
        hasAmbiguous,
    };
}

/** SVG overlay drawing the student's handwriting and pencil marks on one page. */
export function studentOverlay(student: SimStudent, dummy: DummyTest, page: PageLayout, rng: Rng): string {
    const L = LAYOUT;
    const parts: string[] = [];
    if (page.pageNumber === 1) {
        const field = (text: string, range: typeof L.fields.name, size: number) => {
            const r = rangeRect(range, L);
            parts.push(handwriting(text, { x: r.x + rng.range(6, 20), y: r.y + r.h - rng.range(10, 16) }, size, rng));
        };
        field(student.name, L.fields.name, 30);
        field(student.period, L.fields.period, 26);
        field(student.testName, L.fields.testName, 22);
        field(student.date, L.fields.date, 18);
    }
    const r = ringRadius(L);
    for (const q of page.questions) {
        const centers = ringCenters(dummy.test.questions[q.index]!.choices.length, q.ringRow, L);
        for (const [choice, style] of student.responses[q.index]!.marks) parts.push(markSvg(centers[choice]!, r, style, rng));
    }
    // Occasional doodles in the question text area.
    if (rng.chance(0.4) && page.questions.length) {
        const q = rng.pick(page.questions);
        parts.push(strayMark(colX(20, L), rowY(q.contentRow, L), 300, L.cellH * (q.ringRow - q.contentRow), rng));
    }
    return parts.join("");
}

/** Grades the intended answers the way the grader should. */
export function expectedScore(student: SimStudent, dummy: DummyTest): number {
    return student.responses.filter((r, i) => {
        const k = dummy.key[i]!;
        return r.chosen.length === k.length && r.chosen.every((c, j) => c === k[j]);
    }).length;
}
