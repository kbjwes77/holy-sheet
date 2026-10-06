// Dummy tests with answer keys, and simulated students who fill them in.
import type { GradingKey } from "../src/key.ts";
import { CHOICE_LETTERS, LAYOUT, ROWS_PER_LINE, answerRingRadius, bubbleCenter, rangeRect, responseBoxRect, ringRadius, colX, rowY } from "../src/layout.ts";
import type { AnswerPageLayout } from "./booklet.ts";
import { handwriting, markSvg, strayMark, type MarkStyle } from "./pencil.ts";
import type { Rng } from "./rng.ts";
import { prepareFigure, type Figure, type FigureDef } from "./figures.ts";
import { bubbleColumnOf, figureMaxWidth, type PageLayout, type TestDef } from "./sheet.ts";

export interface DummyTest {
    test: TestDef;
    /** Correct choice indexes per question (empty for a free-response one). */
    key: number[][];
    /** Per question, its free-response model answer and points, or null for multiple choice. */
    free?: ({ answer: string; points: number } | null)[];
}

/** Short answers simulated students write (short enough for one line of a box). */
const WRITTEN = ["Lone pairs push the bonds together", "Because of electron repulsion", "It has two lone pairs", "The bonds repel", "Trigonal pyramidal", "I don't know"];

/** What the mock grader awards a written answer: a stand-in for the model, the same every time. */
export function mockPoints(text: string, max: number): number {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return text ? h % (max + 1) : 0;
}

/** The dummy test as the grader's key: questions worth 1 point, free-response ones their points. */
export function dummyGradingKey(dummy: DummyTest): GradingKey {
    return dummy.test.questions.map((q, i) => {
        const f = dummy.free?.[i];
        return f ? { type: "free", prompt: q.prompt, answer: f.answer, points: f.points } : { type: "choice", answer: dummy.key[i]!, points: 1 };
    });
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

function choiceText(rng: Rng, short = false): string {
    const n = short ? rng.int(1, 2) : rng.int(1, 5);
    return Array.from({ length: n }, () => rng.pick(WORDS)).join(" and ").replace(/^./, (c) => c.toUpperCase());
}

/**
 * Figures for dummy tests, chosen to stress the grader: a graph with a solid black block and
 * heavy lines, a wide table with shaded headers, and a small diagram. Widths vary per test.
 */
function dummyFigures(rng: Rng): Figure[] {
    const w = () => +rng.range(1.2, 4).toFixed(2);
    const defs: [string, FigureDef][] = [
        [
            "graph",
            {
                type: "svg",
                width: w(),
                caption: "Figure: supply and demand",
                content:
                    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 150"><rect x="20" y="10" width="40" height="40" fill="#000"/>` +
                    `<path d="M20 10 V140 H195" fill="none" stroke="#000" stroke-width="4"/><path d="M30 20 L180 130 M30 130 L180 20" stroke="#000" stroke-width="3"/>` +
                    `<text x="150" y="40" font-size="14">S</text><text x="150" y="125" font-size="14">D</text></svg>`,
            },
        ],
        [
            "table",
            {
                type: "table",
                content:
                    `<table><thead><tr><th>Item</th><th>2024</th><th>2025</th><th>Change</th></tr></thead><tbody>` +
                    `<tr><td>Price</td><td>$1.20</td><td>$1.45</td><td>+20.8%</td></tr><tr><td>Quantity</td><td>500</td><td>430</td><td>-14.0%</td></tr>` +
                    `<tr><td>r<sub>1</sub> <b>total</b></td><td>600</td><td>624</td><td>+4.0%</td></tr></tbody></table>`,
            },
        ],
        ["diagram", { type: "svg", width: w(), content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><circle cx="20" cy="20" r="15" fill="#888"/><rect x="50" y="5" width="40" height="30" fill="none" stroke="#000" stroke-width="2"/></svg>` }],
    ];
    return defs.map(([id, def]) => {
        const r = prepareFigure(id, def, figureMaxWidth());
        if (!r.ok) throw new Error(r.errors.join("; "));
        return r.figure;
    });
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

/**
 * `figureRate` is the chance a question shows one or two figures (0 leaves the rng sequence
 * unchanged). `shortChoices` keeps choices to a word or two, so most questions print in columns.
 * `freeRate` is the chance a question is free response (0 leaves the rng sequence unchanged);
 * with any, multiple-choice questions have at least 2 choices.
 */
export function makeDummyTest(rng: Rng, questionCount: number, title = "Unit 4 Quiz", figureRate = 0, shortChoices = false, freeRate = 0): DummyTest {
    const key: number[][] = [];
    const free: DummyTest["free"] = [];
    const figures = figureRate > 0 ? dummyFigures(rng) : [];
    const questions = Array.from({ length: questionCount }, () => {
        if (freeRate > 0 && rng.chance(freeRate)) {
            key.push([]);
            free.push({ answer: "The two lone pairs on oxygen repel the bonding pairs, bending the molecule.", points: rng.int(1, 4) });
            return { prompt: `Explain ${rng.pick(SUBJECTS)} in a sentence.`, choices: [], lines: rng.int(1, 4) };
        }
        free.push(null);
        const n = freeRate > 0 ? Math.max(2, choiceCount(rng)) : choiceCount(rng);
        const stem = rng.pick(STEMS).replace("{s}", rng.pick(SUBJECTS));
        const multi = stem.startsWith("Select all") && n >= 3;
        let answer = [rng.int(0, n - 1)];
        if (multi) {
            const set = new Set(answer);
            while (set.size < Math.min(n, rng.int(2, 3))) set.add(rng.int(0, n - 1));
            answer = [...set].sort((a, b) => a - b);
        }
        key.push(answer);
        const choices = Array.from({ length: n }, () => choiceText(rng, shortChoices));
        if (!figures.length || !rng.chance(figureRate)) return { prompt: stem, choices };
        const shown = rng.chance(0.3) ? [rng.pick(figures), rng.pick(figures)] : [rng.pick(figures)];
        return { prompt: stem, choices, figures: [...new Set(shown)] };
    });
    return { test: { title, questions }, key, ...(freeRate > 0 ? { free } : {}) };
}

export function keyToString(key: number[][]): string {
    return key.map((k) => k.map((i) => CHOICE_LETTERS[i]).join("")).join(",");
}

export interface Response {
    /** Choices that are meant to be read as marked. */
    chosen: number[];
    /** Drawn marks per choice index (chosen and otherwise). */
    marks: Map<number, MarkStyle>;
    /** A free-response question's handwritten answer ("" for blank). */
    text?: string;
}

export interface SimStudent {
    name: string;
    period: string;
    date: string;
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
        if (dummy.free?.[qi]) return { chosen: [], marks: new Map(), text: rng.chance(0.15) ? "" : rng.pick(WRITTEN) };
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
        const r = rng.pick(responses.filter((r, i) => r.marks.size < 8 && !dummy.free?.[i]));
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
        responses,
        hasAmbiguous,
    };
}

/** The student's handwriting in page 1's fields. */
function fieldsOverlay(student: SimStudent, rng: Rng): string {
    const L = LAYOUT;
    const field = (text: string, range: typeof L.fields.name, size: number) => {
        const r = rangeRect(range, L);
        return handwriting(text, { x: r.x + rng.range(6, 20), y: r.y + r.h - rng.range(10, 16) }, size, rng);
    };
    return field(student.name, L.fields.name, 30) + field(student.period, L.fields.period, 26) + field(student.date, L.fields.date, 18);
}

/** A written answer on the first line of the box from grid row `row`. */
function boxOverlay(text: string | undefined, row: number, rng: Rng): string {
    if (!text) return "";
    const r = responseBoxRect(row, 1);
    return handwriting(text, { x: r.x + rng.range(8, 24), y: rowY(row + ROWS_PER_LINE) - rng.range(5, 9) }, 20, rng);
}

/** SVG overlay drawing the student's handwriting and pencil marks on one page of a separate answer sheet. */
export function answerSheetOverlay(student: SimStudent, page: AnswerPageLayout, rng: Rng): string {
    const parts: string[] = [];
    if (page.pageNumber === 1) parts.push(fieldsOverlay(student, rng));
    const r = answerRingRadius(LAYOUT);
    for (const q of page.questions) {
        for (const [choice, style] of student.responses[q.index]!.marks) parts.push(markSvg(q.centers[choice]!, r, style, rng));
    }
    for (const b of page.boxes) parts.push(boxOverlay(student.responses[b.index]!.text, b.row, rng));
    // An occasional doodle under the last row, clear of the bubbles and boxes.
    const last = Math.max(...page.questions.map((q) => q.row), ...page.boxes.map((b) => b.row + b.rows));
    if (rng.chance(0.4) && last + 3 <= LAYOUT.bodyLastRow) {
        parts.push(strayMark(colX(8), rowY(last + 2), colX(30) - colX(8), (LAYOUT.bodyLastRow - last - 2) * LAYOUT.cellH, rng));
    }
    return parts.join("");
}

/** SVG overlay drawing the student's handwriting and pencil marks on one page. */
export function studentOverlay(student: SimStudent, dummy: DummyTest, page: PageLayout, rng: Rng): string {
    const L = LAYOUT;
    const parts: string[] = [];
    if (page.pageNumber === 1) parts.push(fieldsOverlay(student, rng));
    const r = ringRadius(L);
    for (const q of page.questions) {
        if (q.box) parts.push(boxOverlay(student.responses[q.index]!.text, q.box.row, rng));
        for (const [choice, style] of student.responses[q.index]!.marks) {
            parts.push(markSvg(bubbleCenter(q.choices[choice]!.row, bubbleColumnOf(q.column), L), r, style, rng));
        }
    }
    // Occasional doodles in a multiple-choice question's text, kept clear of both bubble columns.
    const withChoices = page.questions.filter((q) => q.choices.length);
    if (rng.chance(0.4) && withChoices.length) {
        const q = rng.pick(withChoices);
        const last = q.choices.at(-1)!;
        const [from, to] = q.column === "right" ? [31, 43] : [8, 22];
        parts.push(strayMark(colX(from, L), rowY(q.promptRow, L), colX(to, L) - colX(from, L), L.cellH * (last.row + last.lines.length - q.promptRow), rng));
    }
    return parts.join("");
}

/**
 * Grades the intended answers the way the grader should: 1 point per multiple-choice question,
 * and for a free-response one what the mock grader awards its text.
 */
export function expectedScore(student: SimStudent, dummy: DummyTest): number {
    return student.responses.reduce((sum, r, i) => {
        const f = dummy.free?.[i];
        if (f) return sum + mockPoints(r.text ?? "", f.points);
        const k = dummy.key[i]!;
        return sum + (r.chosen.length === k.length && r.chosen.every((c, j) => c === k[j]) ? 1 : 0);
    }, 0);
}

/** The test's total points. */
export function totalPoints(dummy: DummyTest): number {
    return dummy.test.questions.reduce((sum, _, i) => sum + (dummy.free?.[i]?.points ?? 1), 0);
}
