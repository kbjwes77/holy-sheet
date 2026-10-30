// The free generator's Simple-mode model, kept free of the DOM so it can be unit-tested.
//   toDoc()     Simple state -> the Test JSON object
//   importDoc() Test JSON object -> Simple state (anything Simple can't edit is kept in `extra` and written back)

export const MAX_SIMPLE_QUESTIONS = 60;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 8;
export type SheetKind = "Quiz" | "Exam" | "Study Guide";

export interface SimpleQuestion {
    kind: "mc" | "free";
    prompt: string;
    choices: string[];
    /** Indices into `choices` that are correct. */
    correct: number[];
    /** Free response: the model answer. */
    model: string;
    rubric: string;
    explanation: string;
    points: number | undefined;
    lines: number | undefined;
    /** Keys Simple mode doesn't edit (e.g. "figures"), written back unchanged. */
    extra: Record<string, unknown>;
}

export interface SimpleState {
    name: string;
    type: SheetKind;
    key: boolean;
    questions: SimpleQuestion[];
    /** Root keys Simple mode doesn't edit: figures, instructions, columns. */
    extra: Record<string, unknown>;
}

const QUESTION_EDITED = new Set(["type", "prompt", "choices", "answer", "points", "rubric", "lines", "explanation"]);
const ROOT_EDITED = new Set(["test", "title", "name", "testname", "type", "questions"]);

export function newQuestion(kind: "mc" | "free", choiceCount = 4): SimpleQuestion {
    const n = Math.min(MAX_CHOICES, Math.max(MIN_CHOICES, Math.round(choiceCount) || 4));
    return {
        kind,
        prompt: "",
        choices: kind === "mc" ? Array.from({ length: n }, () => "") : [],
        correct: [],
        model: "",
        rubric: "",
        explanation: "",
        points: undefined,
        lines: undefined,
        extra: {},
    };
}

export function newState(): SimpleState {
    return { name: "", type: "Quiz", key: true, questions: [newQuestion("mc"), newQuestion("mc")], extra: {} };
}

export const letter = (i: number) => String.fromCharCode(65 + i);

/** The letters of a question's correct choices, in order ("AC"); "" when none is ticked. */
export function answerLetters(q: SimpleQuestion): string {
    return [...new Set(q.correct)]
        .filter((i) => i >= 0 && i < q.choices.length)
        .sort((a, b) => a - b)
        .map(letter)
        .join("");
}

/** The answer a question has, or "" when it has none yet. */
export function answerOf(q: SimpleQuestion): string {
    return q.kind === "mc" ? answerLetters(q) : q.model.trim();
}

/** The 1-based numbers of questions that still need an answer (only meaningful when answers are wanted). */
export function missingAnswers(s: SimpleState): number[] {
    return s.questions.flatMap((q, i) => (answerOf(q) ? [] : [i + 1]));
}

export interface ToDocOptions {
    /** Fill in a stand-in for every missing answer, so a half-finished test can still be previewed. */
    placeholders?: boolean;
}

export function toDoc(s: SimpleState, opts: ToDocOptions = {}): Record<string, unknown> {
    const study = s.type === "Study Guide";
    const missing = missingAnswers(s);
    // A quiz or exam keeps its answers when asked to; a study guide keeps them only if every question has one (all or none).
    const withAnswers = study ? missing.length === 0 : s.key;
    const questions = s.questions.map((q) => {
        const out: Record<string, unknown> = {};
        if (q.kind === "free") out.type = "Free Response";
        out.prompt = q.prompt.trim() || (opts.placeholders ? "Type your question here" : "");
        if (q.kind === "mc") out.choices = q.choices.map((c, i) => c.trim() || (opts.placeholders ? `Choice ${letter(i)}` : ""));
        const a = answerOf(q);
        if (withAnswers && (a || opts.placeholders)) out.answer = a || (q.kind === "mc" ? "A" : "Sample answer");
        if (q.kind === "free" && q.rubric.trim()) out.rubric = q.rubric.trim();
        if (q.points !== undefined) out.points = q.points;
        if (q.lines !== undefined && q.kind === "free") out.lines = q.lines;
        if (q.explanation.trim()) out.explanation = q.explanation.trim();
        return { ...out, ...q.extra };
    });
    return { test: s.name.trim() || (opts.placeholders ? "Untitled test" : ""), type: s.type, questions, ...s.extra };
}

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z]/g, "");
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const posInt = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);

/** Turns a parsed Test JSON object into Simple state, or null when it isn't an object with a questions array. */
export function importDoc(doc: unknown): SimpleState | null {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    const d = doc as Record<string, unknown>;
    if (!Array.isArray(d.questions)) return null;
    const typeKey = norm(d.type);
    const type: SheetKind = typeKey === "exam" ? "Exam" : typeKey === "studyguide" ? "Study Guide" : "Quiz";
    let hasAnswer = false;
    const questions: SimpleQuestion[] = d.questions.map((raw) => {
        const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const free = norm(r.type) === "freeresponse" || !Array.isArray(r.choices);
        const q = newQuestion(free ? "free" : "mc");
        q.prompt = str(r.prompt);
        q.explanation = str(r.explanation);
        q.rubric = str(r.rubric);
        q.points = posInt(r.points);
        q.lines = posInt(r.lines);
        if (free) {
            q.model = str(r.answer);
        } else {
            q.choices = (r.choices as unknown[]).map(str);
            const letters = str(r.answer).toUpperCase().replace(/[^A-H]/g, "");
            q.correct = [...new Set([...letters].map((c) => c.charCodeAt(0) - 65))].filter((i) => i < q.choices.length);
        }
        if (answerOf(q)) hasAnswer = true;
        for (const [k, v] of Object.entries(r)) if (!QUESTION_EDITED.has(k)) q.extra[k] = v;
        return q;
    });
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) if (!ROOT_EDITED.has(k)) extra[k] = v;
    return {
        name: str(d.test ?? d.title ?? d.name ?? d.testname),
        type,
        key: type === "Study Guide" ? true : hasAnswer || questions.length === 0,
        questions,
        extra,
    };
}

/** Whether Simple mode is holding things it can't edit (figures, instructions, columns...). */
export function hasExtras(s: SimpleState): boolean {
    return Object.keys(s.extra).some((k) => k !== "columns") || s.questions.some((q) => Object.keys(q.extra).length > 0);
}
