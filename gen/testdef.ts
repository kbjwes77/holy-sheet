// Parses and strictly validates the sheet JSON the web generator (and the grader's --test) accepts:
//   { "test": "...",
//     "questions": [
//       { "type"?: "Multiple Choice", "prompt": "...", "figures"?: ["id", ...], "choices": ["...", ...], "answer"?: "AC", "points"?: 2 },
//       { "type": "Free Response", "prompt": "...", "figures"?: [...], "answer": "<model answer>", "rubric"?: "...", "lines"?: 3, "points"?: 4 } ],
//     "figures"?: { "id": { "type": "svg" | "table", "content": "<svg>…</svg>", "width"?: inches, "caption"?: "..." } } }
// Every problem is collected (not just the first), each with a JSON path and a readable location.
import { MAX_PAGES, MAX_QUESTIONS } from "../src/codec.ts";
import type { GradingKey } from "../src/key.ts";
import { CHOICE_LETTERS, LAYOUT } from "../src/layout.ts";
import { FIGURE_ID, FIGURE_TYPES, MAX_FIGURE_CONTENT, prepareFigure, type Figure, type FigureType } from "./figures.ts";
import { blankPagesAfter, layoutAnswerSheet, layoutBooklet } from "./booklet.ts";
import { figureMaxWidth, paginate, QuestionTooLongError, type TestDef } from "./sheet.ts";
import { unprintable } from "./textwidth.ts";

export const MIN_CHOICES = 2;
export const MAX_CHOICES = LAYOUT.ring.maxChoices;
export const MAX_TEST_NAME = 200;
export const MAX_TEXT = 2000;
export const MULTIPLE_CHOICE = "Multiple Choice";
export const FREE_RESPONSE = "Free Response";
export const QUESTION_TYPES = [MULTIPLE_CHOICE, FREE_RESPONSE];
/** A free-response question's writing lines when it gives none, and the most it may ask for. */
export const DEFAULT_LINES = 3;
export const MAX_LINES = 20;
export const MAX_POINTS = 100;

export interface ValidationIssue {
    /** JSON path, e.g. `questions[2].choices[4]`; empty for whole-document problems. */
    path: string;
    /** Human location, e.g. `Question 3, choice E`. */
    where: string;
    message: string;
}

export type ParseResult =
    | {
          ok: true;
          test: TestDef;
          /** Grader key line (e.g. `A,AB,D`) when every question has an answer and none is free response, else null. */
          key: string | null;
          /** How each question is graded and what it's worth, when every question has an answer, else null. */
          grading: GradingKey | null;
          pageCount: number;
          /** Non-blocking remarks, e.g. a figure no question uses. */
          notes: ValidationIssue[];
      }
    | { ok: false; errors: ValidationIssue[] };

const ROOT_KEYS = ["test", "questions", "figures"];
const QUESTION_KEYS = ["type", "prompt", "figures", "choices", "answer", "points", "rubric", "lines"];
const FIGURE_KEYS = ["type", "content", "width", "caption"];
const ALIASES: Record<string, string> = {
    title: "test",
    name: "test",
    testname: "test",
    question: "questions",
    items: "questions",
    text: "prompt",
    stem: "prompt",
    options: "choices",
    choice: "choices",
    answers: "answer",
    correct: "answer",
    key: "answer",
    solution: "answer",
    point: "points",
    score: "points",
    weight: "points",
    criteria: "rubric",
    rows: "lines",
    qtype: "type",
    questiontype: "type",
    figure: "figures",
    image: "figures",
    images: "figures",
    svg: "content",
    html: "content",
    src: "content",
    kind: "type",
    label: "caption",
};

function typeName(v: unknown): string {
    if (v === null) return "null";
    if (Array.isArray(v)) return "an array";
    return typeof v === "object" ? "an object" : `a ${typeof v}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function suggest(key: string, allowed: string[]): string {
    const k = key.toLowerCase().replace(/[\s_-]/g, "");
    const hit = allowed.find((a) => a === k) ?? (ALIASES[k] && allowed.includes(ALIASES[k]!) ? ALIASES[k] : undefined);
    return hit ? ` Did you mean "${hit}"?` : "";
}

/** The id closest to `id` (same letters ignoring case, or at most 2 edits away), if any. */
function closest(id: string, ids: string[]): string | undefined {
    const dist = (a: string, b: string) => {
        const d = Array.from({ length: b.length + 1 }, (_, j) => j);
        for (let i = 1; i <= a.length; i++) {
            let prev = d[0]!;
            d[0] = i;
            for (let j = 1; j <= b.length; j++) {
                const tmp = d[j]!;
                d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
                prev = tmp;
            }
        }
        return d[b.length]!;
    };
    let best: { id: string; d: number } | undefined;
    for (const other of ids) {
        const d = dist(id.toLowerCase(), other.toLowerCase());
        if (d <= 2 && (!best || d < best.d)) best = { id: other, d };
    }
    return best?.id;
}

/** Converts a JSON.parse message's "position N" into line/column where the engine provides it. */
function describeSyntaxError(text: string, err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (/line \d+ column \d+/.test(msg)) return msg;
    const m = /position (\d+)/.exec(msg);
    if (!m) return msg;
    const before = text.slice(0, Number(m[1]));
    const line = before.split("\n").length;
    const col = before.length - before.lastIndexOf("\n");
    return `${msg} (line ${line}, column ${col})`;
}

export interface ParseOptions {
    /** Lay the test out as question pages plus a separate answer sheet (see booklet.ts). */
    answerSheet?: boolean;
    /** False skips laying the test out (the grader, reading a test already printed); `pageCount` is then 0. */
    layout?: boolean;
}

export function parseSheetJson(text: string, opts: ParseOptions = {}): ParseResult {
    const errors: ValidationIssue[] = [];
    const add = (path: string, where: string, message: string) => errors.push({ path, where, message });

    if (!text.trim()) return { ok: false, errors: [{ path: "", where: "Input", message: "Paste sheet JSON or load a .json file." }] };
    let doc: unknown;
    try {
        doc = JSON.parse(text.replace(/^﻿/, ""));
    } catch (e) {
        return { ok: false, errors: [{ path: "", where: "JSON syntax", message: describeSyntaxError(text, e) }] };
    }
    if (!isObject(doc)) {
        return {
            ok: false,
            errors: [{ path: "", where: "Document", message: `Expected an object with "test" and "questions", got ${typeName(doc)}.` }],
        };
    }

    /** `printed` text must use only characters the sheet's font has; text only the grader reads needn't. */
    const checkText = (v: unknown, path: string, where: string, max: number, printed = true): v is string => {
        if (typeof v !== "string") {
            add(path, where, `Expected text, got ${typeName(v)}.`);
            return false;
        }
        if (!v.trim()) {
            add(path, where, "Must not be empty.");
            return false;
        }
        if (v.length > max) add(path, where, `Too long: ${v.length} characters (max ${max}).`);
        if (!printed) return true;
        const list = unprintable(v);
        if (list) add(path, where, `Contains ${list}, which can't be printed with the sheet's font.`);
        return true;
    };

    for (const k of Object.keys(doc)) {
        if (!ROOT_KEYS.includes(k)) add(k, "Document", `Unknown key "${k}".${suggest(k, ROOT_KEYS)}`);
    }
    if (!("test" in doc)) add("test", "Test name", `Missing "test" (the test name).`);
    else checkText(doc.test, "test", "Test name", MAX_TEST_NAME);

    // Figures first, so questions can be checked against their ids.
    const figures = new Map<string, Figure>();
    const figureIds: string[] = [];
    if ("figures" in doc) {
        const figs = doc.figures;
        if (!isObject(figs)) add("figures", "Figures", `Expected an object of figures by id, got ${typeName(figs)}.`);
        else
            for (const [id, def] of Object.entries(figs)) {
                const path = `figures.${id}`;
                const where = `Figure "${id}"`;
                figureIds.push(id);
                if (!FIGURE_ID.test(id)) add(path, where, "Ids may use letters, digits, - and _ (up to 64).");
                if (!isObject(def)) {
                    add(path, where, `Expected an object with "type" and "content", got ${typeName(def)}.`);
                    continue;
                }
                const before = errors.length;
                for (const k of Object.keys(def)) {
                    if (!FIGURE_KEYS.includes(k)) add(`${path}.${k}`, where, `Unknown key "${k}".${suggest(k, FIGURE_KEYS)}`);
                }
                if (!("type" in def)) add(`${path}.type`, where, `Missing "type" ("svg" or "table").`);
                else if (!FIGURE_TYPES.includes(def.type as FigureType)) {
                    add(`${path}.type`, where, `"type" must be "svg" or "table", got ${JSON.stringify(def.type)}.`);
                }
                if (!("content" in def)) add(`${path}.content`, where, `Missing "content" (the <svg> or <table> markup).`);
                else if (typeof def.content !== "string" || !def.content.trim()) add(`${path}.content`, where, "Expected the markup as text.");
                else if (def.content.length > MAX_FIGURE_CONTENT) {
                    add(`${path}.content`, where, `Too long: ${def.content.length} characters (max ${MAX_FIGURE_CONTENT}).`);
                }
                if ("width" in def && (typeof def.width !== "number" || !(def.width > 0))) {
                    add(`${path}.width`, where, `"width" must be a number of inches greater than 0, got ${JSON.stringify(def.width)}.`);
                }
                if ("caption" in def) checkText(def.caption, `${path}.caption`, `${where}, caption`, MAX_TEXT);
                if (errors.length > before) continue;
                const result = prepareFigure(id, def as never, figureMaxWidth());
                if (result.ok) figures.set(id, result.figure);
                else for (const m of result.errors) add(m.startsWith('"width"') ? `${path}.width` : `${path}.content`, where, m);
            }
    }
    const used = new Set<string>();

    /** Per question: whether it has an answer, and what the grader needs to grade it. */
    const parsed: { answer: string | null; free: boolean; points: number; rubric?: string; lines: number }[] = [];
    if (!("questions" in doc)) add("questions", "Questions", `Missing "questions".`);
    else if (!Array.isArray(doc.questions)) add("questions", "Questions", `Expected an array, got ${typeName(doc.questions)}.`);
    else if (doc.questions.length === 0) add("questions", "Questions", "Must contain at least 1 question.");
    else if (doc.questions.length > MAX_QUESTIONS) {
        add("questions", "Questions", `Too many questions: ${doc.questions.length} (max ${MAX_QUESTIONS}).`);
    } else {
        doc.questions.forEach((q, i) => {
            const path = `questions[${i}]`;
            const where = `Question ${i + 1}`;
            const entry: (typeof parsed)[number] = { answer: null, free: false, points: 1, lines: DEFAULT_LINES };
            parsed.push(entry);
            if (!isObject(q)) {
                add(path, where, `Expected an object with "prompt" and "choices", got ${typeName(q)}.`);
                return;
            }
            for (const k of Object.keys(q)) {
                if (!QUESTION_KEYS.includes(k)) add(`${path}.${k}`, where, `Unknown key "${k}".${suggest(k, QUESTION_KEYS)}`);
            }
            if ("type" in q) {
                const t = typeof q.type === "string" ? QUESTION_TYPES.find((name) => name.toLowerCase() === (q.type as string).trim().toLowerCase()) : undefined;
                if (t) entry.free = t === FREE_RESPONSE;
                else add(`${path}.type`, where, `"type" must be "${MULTIPLE_CHOICE}" or "${FREE_RESPONSE}", got ${JSON.stringify(q.type)}.`);
            }
            if (!("prompt" in q)) add(`${path}.prompt`, where, `Missing "prompt".`);
            else checkText(q.prompt, `${path}.prompt`, `${where}, prompt`, MAX_TEXT);

            if ("figures" in q) {
                const fpath = `${path}.figures`;
                if (!Array.isArray(q.figures)) add(fpath, where, `"figures" must be an array of figure ids, got ${typeName(q.figures)}.`);
                else {
                    const seen = new Set<string>();
                    q.figures.forEach((id, j) => {
                        if (typeof id !== "string") return add(`${fpath}[${j}]`, `${where}, figures`, `Expected a figure id, got ${typeName(id)}.`);
                        if (seen.has(id)) add(`${fpath}[${j}]`, `${where}, figures`, `Lists "${id}" twice.`);
                        seen.add(id);
                        used.add(id);
                        if (figureIds.includes(id)) return;
                        const near = closest(id, figureIds);
                        const hint = near ? ` Did you mean "${near}"?` : figureIds.length ? "" : ` Define it under "figures" at the end of the file.`;
                        add(`${fpath}[${j}]`, `${where}, figures`, `No figure "${id}".${hint}`);
                    });
                }
            }

            if ("points" in q) {
                const p = q.points;
                if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > MAX_POINTS) {
                    add(`${path}.points`, `${where}, points`, `"points" must be a whole number from 1 to ${MAX_POINTS}, got ${JSON.stringify(p)}.`);
                } else entry.points = p;
            }

            if (entry.free) {
                const freeOnly = `on a "${FREE_RESPONSE}" question; it has a writing box instead.`;
                if ("choices" in q) add(`${path}.choices`, where, `"choices" isn't allowed ${freeOnly}`);
                if ("lines" in q) {
                    const n = q.lines;
                    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_LINES) {
                        add(`${path}.lines`, `${where}, lines`, `"lines" must be a whole number from 1 to ${MAX_LINES}, got ${JSON.stringify(n)}.`);
                    } else entry.lines = n;
                }
                if ("rubric" in q && checkText(q.rubric, `${path}.rubric`, `${where}, rubric`, MAX_TEXT, false)) entry.rubric = q.rubric.trim();
                if (!("answer" in q)) add(`${path}.answer`, where, `Missing "answer" (the model answer the grader compares the student's answer with).`);
                else if (checkText(q.answer, `${path}.answer`, `${where}, answer`, MAX_TEXT, false)) entry.answer = q.answer.trim();
                return;
            }

            const mcOnly = (k: string) => add(`${path}.${k}`, where, `"${k}" is only for "${FREE_RESPONSE}" questions; add "type": "${FREE_RESPONSE}" or remove it.`);
            if ("lines" in q) mcOnly("lines");
            if ("rubric" in q) mcOnly("rubric");
            let choiceCount = 0;
            if (!("choices" in q)) add(`${path}.choices`, where, `Missing "choices". A question without choices needs "type": "${FREE_RESPONSE}".`);
            else if (!Array.isArray(q.choices)) add(`${path}.choices`, where, `"choices" must be an array, got ${typeName(q.choices)}.`);
            else if (q.choices.length < MIN_CHOICES || q.choices.length > MAX_CHOICES) {
                add(`${path}.choices`, where, `Expected ${MIN_CHOICES}–${MAX_CHOICES} choices, got ${q.choices.length}.`);
            } else {
                choiceCount = q.choices.length;
                q.choices.forEach((c, j) =>
                    checkText(c, `${path}.choices[${j}]`, `${where}, choice ${CHOICE_LETTERS[j]}`, MAX_TEXT),
                );
            }

            if (!("answer" in q)) return;
            const a = q.answer;
            const apath = `${path}.answer`;
            const awhere = `${where}, answer`;
            entry.answer = "";
            if (typeof a !== "string" || !/^[A-Za-z]+$/.test(a.trim())) {
                const hint = typeof a === "string" && /\s/.test(a.trim()) ? ` For a written answer, add "type": "${FREE_RESPONSE}".` : "";
                add(apath, awhere, `Expected choice letters such as "B" or "AC", got ${typeof a === "string" ? JSON.stringify(a) : typeName(a)}.${hint}`);
                return;
            }
            const letters = [...new Set(a.trim().toUpperCase())].sort();
            if (letters.length !== a.trim().length) add(apath, awhere, `Repeats a letter: "${a}".`);
            if (choiceCount) {
                const allowed = CHOICE_LETTERS.slice(0, choiceCount);
                const out = letters.filter((l) => !allowed.includes(l));
                if (out.length) add(apath, awhere, `"${out.join("")}" is not a choice (this question has ${allowed[0]}–${allowed.at(-1)}).`);
            }
            entry.answer = letters.join("");
        });

        // Free-response questions always have an answer, so a test with one needs every answer.
        const given = parsed.filter((a) => a.answer !== null).length;
        if (given > 0 && given < parsed.length) {
            const missing = parsed.flatMap((a, i) => (a.answer === null ? [i + 1] : []));
            const shown = missing.length > 12 ? `${missing.slice(0, 12).join(", ")}, …` : missing.join(", ");
            const why = parsed.some((a) => a.free) ? " (a test with free-response questions is graded from this file, so it needs every answer)" : "";
            add(
                "questions[].answer",
                "Answers",
                `${given} of ${parsed.length} questions have an "answer"; give one for every question or none${why}. Missing: ${shown}.`,
            );
        }
    }

    if (errors.length) return { ok: false, errors };

    const raw = doc as { test: string; questions: { prompt: string; choices?: string[]; figures?: string[] }[] };
    const test: TestDef = {
        title: raw.test.trim(),
        questions: raw.questions.map((q, i) => ({
            prompt: q.prompt.trim(),
            choices: parsed[i]!.free ? [] : q.choices!.map((c) => c.trim()),
            ...(q.figures?.length ? { figures: q.figures.map((id) => figures.get(id)!) } : {}),
            ...(parsed[i]!.free ? { lines: parsed[i]!.lines } : {}),
        })),
    };
    const notes: ValidationIssue[] = figureIds
        .filter((id) => !used.has(id))
        .map((id) => ({ path: `figures.${id}`, where: `Figure "${id}"`, message: "Isn't used by any question, so it isn't printed." }));
    let pageCount = 0;
    try {
        if (opts.layout === false) {
            // Not laid out.
        } else if (opts.answerSheet) {
            const answerPages = layoutAnswerSheet(test).length;
            if (answerPages > MAX_PAGES) {
                const message = `The answer sheet needs ${answerPages} pages; it can have at most ${MAX_PAGES}.`;
                return { ok: false, errors: [{ path: "questions", where: "Questions", message }] };
            }
            const questionPages = layoutBooklet(test).length;
            pageCount = questionPages + blankPagesAfter(questionPages) + answerPages;
        } else {
            pageCount = paginate(test).length;
        }
    } catch (e) {
        if (!(e instanceof QuestionTooLongError)) throw e;
        const i = e.index;
        if (e.fits === "column") {
            const message = "Too long to fit in one column of a question page; shorten the prompt or choices, or make its figures smaller.";
            return { ok: false, errors: [{ path: `questions[${i}]`, where: `Question ${i + 1}`, message }] };
        }
        const rows = LAYOUT.bodyLastRow - LAYOUT.firstRowContinued + 1;
        const message = e.figureRows
            ? `Too long to fit on one page: its figures take ${e.figureRows} of a page's ${rows} rows. Make them smaller ("width") or shorten the prompt or choices.`
            : test.questions[i]!.lines
              ? 'Too long to fit on one page; shorten the prompt or give it fewer "lines".'
              : "Too long to fit on one page; shorten the prompt or choices.";
        return { ok: false, errors: [{ path: `questions[${i}]`, where: `Question ${i + 1}`, message }] };
    }
    // Only scanned pages carry a page number in their QR; question pages are never scanned.
    if (!opts.answerSheet && pageCount > MAX_PAGES) {
        return {
            ok: false,
            errors: [{ path: "questions", where: "Questions", message: `Needs ${pageCount} pages; a sheet can have at most ${MAX_PAGES}.` }],
        };
    }
    const answered = parsed.every((a) => a.answer !== null);
    const key = answered && !parsed.some((a) => a.free) ? parsed.map((a) => a.answer).join(",") : null;
    const grading: GradingKey | null = answered
        ? parsed.map((a, i) =>
              a.free
                  ? { type: "free", prompt: test.questions[i]!.prompt, answer: a.answer!, ...(a.rubric ? { rubric: a.rubric } : {}), points: a.points }
                  : { type: "choice", answer: [...a.answer!].map((l) => CHOICE_LETTERS.indexOf(l)), points: a.points },
          )
        : null;
    return { ok: true, test, key, grading, pageCount, notes };
}
