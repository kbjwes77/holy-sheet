// Parses and strictly validates the sheet JSON the web generator accepts:
//   { "test": "...",
//     "questions": [ { "prompt": "...", "figures"?: ["id", ...], "choices": ["...", ...], "answer"?: "AC" } ],
//     "figures"?: { "id": { "type": "svg" | "table", "content": "<svg>…</svg>", "width"?: inches, "caption"?: "..." } } }
// Every problem is collected (not just the first), each with a JSON path and a readable location.
import { MAX_PAGES, MAX_QUESTIONS } from "../src/codec.ts";
import { CHOICE_LETTERS, LAYOUT } from "../src/layout.ts";
import { FIGURE_ID, FIGURE_TYPES, MAX_FIGURE_CONTENT, prepareFigure, type Figure, type FigureType } from "./figures.ts";
import { figureMaxWidth, paginate, QuestionTooLongError, type TestDef } from "./sheet.ts";
import { unprintable } from "./textwidth.ts";

export const MIN_CHOICES = 2;
export const MAX_CHOICES = LAYOUT.ring.maxChoices;
export const MAX_TEST_NAME = 200;
export const MAX_TEXT = 2000;

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
          /** Grader key line (e.g. `A,AB,D`) when every question has an answer, else null. */
          key: string | null;
          pageCount: number;
          /** Non-blocking remarks, e.g. a figure no question uses. */
          notes: ValidationIssue[];
      }
    | { ok: false; errors: ValidationIssue[] };

const ROOT_KEYS = ["test", "questions", "figures"];
const QUESTION_KEYS = ["prompt", "figures", "choices", "answer"];
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

export function parseSheetJson(text: string): ParseResult {
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

    const checkText = (v: unknown, path: string, where: string, max: number): v is string => {
        if (typeof v !== "string") {
            add(path, where, `Expected text, got ${typeName(v)}.`);
            return false;
        }
        if (!v.trim()) {
            add(path, where, "Must not be empty.");
            return false;
        }
        if (v.length > max) add(path, where, `Too long: ${v.length} characters (max ${max}).`);
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

    const answers: (string | null)[] = [];
    if (!("questions" in doc)) add("questions", "Questions", `Missing "questions".`);
    else if (!Array.isArray(doc.questions)) add("questions", "Questions", `Expected an array, got ${typeName(doc.questions)}.`);
    else if (doc.questions.length === 0) add("questions", "Questions", "Must contain at least 1 question.");
    else if (doc.questions.length > MAX_QUESTIONS) {
        add("questions", "Questions", `Too many questions: ${doc.questions.length} (max ${MAX_QUESTIONS}).`);
    } else {
        doc.questions.forEach((q, i) => {
            const path = `questions[${i}]`;
            const where = `Question ${i + 1}`;
            if (!isObject(q)) {
                add(path, where, `Expected an object with "prompt" and "choices", got ${typeName(q)}.`);
                answers.push(null);
                return;
            }
            for (const k of Object.keys(q)) {
                if (!QUESTION_KEYS.includes(k)) add(`${path}.${k}`, where, `Unknown key "${k}".${suggest(k, QUESTION_KEYS)}`);
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

            let choiceCount = 0;
            if (!("choices" in q)) add(`${path}.choices`, where, `Missing "choices".`);
            else if (!Array.isArray(q.choices)) add(`${path}.choices`, where, `"choices" must be an array, got ${typeName(q.choices)}.`);
            else if (q.choices.length < MIN_CHOICES || q.choices.length > MAX_CHOICES) {
                add(`${path}.choices`, where, `Expected ${MIN_CHOICES}–${MAX_CHOICES} choices, got ${q.choices.length}.`);
            } else {
                choiceCount = q.choices.length;
                q.choices.forEach((c, j) =>
                    checkText(c, `${path}.choices[${j}]`, `${where}, choice ${CHOICE_LETTERS[j]}`, MAX_TEXT),
                );
            }

            if (!("answer" in q)) {
                answers.push(null);
                return;
            }
            const a = q.answer;
            const apath = `${path}.answer`;
            const awhere = `${where}, answer`;
            answers.push("");
            if (typeof a !== "string" || !/^[A-Za-z]+$/.test(a.trim())) {
                add(apath, awhere, `Expected choice letters such as "B" or "AC", got ${typeof a === "string" ? JSON.stringify(a) : typeName(a)}.`);
                return;
            }
            const letters = [...new Set(a.trim().toUpperCase())].sort();
            if (letters.length !== a.trim().length) add(apath, awhere, `Repeats a letter: "${a}".`);
            if (choiceCount) {
                const allowed = CHOICE_LETTERS.slice(0, choiceCount);
                const out = letters.filter((l) => !allowed.includes(l));
                if (out.length) add(apath, awhere, `"${out.join("")}" is not a choice (this question has ${allowed[0]}–${allowed.at(-1)}).`);
            }
            answers[answers.length - 1] = letters.join("");
        });

        const given = answers.filter((a) => a !== null).length;
        if (given > 0 && given < answers.length) {
            const missing = answers.flatMap((a, i) => (a === null ? [i + 1] : []));
            const shown = missing.length > 12 ? `${missing.slice(0, 12).join(", ")}, …` : missing.join(", ");
            add(
                "questions[].answer",
                "Answers",
                `${given} of ${answers.length} questions have an "answer"; give one for every question or none. Missing: ${shown}.`,
            );
        }
    }

    if (errors.length) return { ok: false, errors };

    const raw = doc as { test: string; questions: { prompt: string; choices: string[]; figures?: string[] }[] };
    const test: TestDef = {
        title: raw.test.trim(),
        questions: raw.questions.map((q) => ({
            prompt: q.prompt.trim(),
            choices: q.choices.map((c) => c.trim()),
            ...(q.figures?.length ? { figures: q.figures.map((id) => figures.get(id)!) } : {}),
        })),
    };
    const notes: ValidationIssue[] = figureIds
        .filter((id) => !used.has(id))
        .map((id) => ({ path: `figures.${id}`, where: `Figure "${id}"`, message: "Isn't used by any question, so it isn't printed." }));
    let pageCount: number;
    try {
        pageCount = paginate(test).length;
    } catch (e) {
        if (!(e instanceof QuestionTooLongError)) throw e;
        const i = e.index;
        const rows = LAYOUT.bodyLastRow - LAYOUT.firstRowContinued + 1;
        const message = e.figureRows
            ? `Too long to fit on one page: its figures take ${e.figureRows} of a page's ${rows} rows. Make them smaller ("width") or shorten the prompt or choices.`
            : "Too long to fit on one page; shorten the prompt or choices.";
        return { ok: false, errors: [{ path: `questions[${i}]`, where: `Question ${i + 1}`, message }] };
    }
    if (pageCount > MAX_PAGES) {
        return {
            ok: false,
            errors: [{ path: "questions", where: "Questions", message: `Needs ${pageCount} pages; a sheet can have at most ${MAX_PAGES}.` }],
        };
    }
    const key = answers.every((a) => a !== null) ? (answers as string[]).join(",") : null;
    return { ok: true, test, key, pageCount, notes };
}
