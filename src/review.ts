// Review (`--review`): instead of skipping a submission for an unclear bubble, an unreadable
// name or a written answer that couldn't be read or graded, the CLI asks. Every graded
// submission's name and written answers' points are confirmed too, since a misread name silently
// files a score under the wrong student. The CLI writes each item's crop and
// review.json, then prompts once per item on stderr, like the key prompt. The web grader shows the
// items as a form and answers the prompts. Browser-safe: no Node imports.
import { CHOICE_LETTERS } from "./layout.ts";

interface ItemBase {
    /** 1-based; the prompt for this item says `Review <id>/<total>`. */
    id: number;
    /** Index of the submission among those being reviewed; a skip drops its remaining items. */
    submission: number;
    /** PNG file name in the review directory. */
    image: string;
}

export interface NameItem extends ItemBase {
    kind: "name";
    /** The submission's pages, page 1 first. */
    files: string[];
    /** The OCR result, or null when it failed (then `error` says why). */
    ocr: string | null;
    error?: string;
}

export interface AnswerItem extends ItemBase {
    kind: "answer";
    file: string;
    /** 1-based question number. */
    question: number;
    choices: number;
    /** Choice indexes read as marked, and those too faint to call. */
    marked: number[];
    unclear: number[];
    /** Fill per choice (0 blank … 1 solid), and how the grader read it against the thresholds. */
    fills: number[];
    verdicts: Verdict[];
    /** Crop size and each bubble's centre and radius in crop pixels, so a page can overlay them. */
    width: number;
    height: number;
    rings: { x: number; y: number; r: number }[];
}

/** A free-response answer: its transcript and the points the grading model gave it. */
export interface ResponseItem extends ItemBase {
    kind: "response";
    file: string;
    /** 1-based question number. */
    question: number;
    /** What the question is worth. */
    maxPoints: number;
    /** The transcript, or null when transcription failed (then `error` says why). */
    text: string | null;
    /** False when the transcriber couldn't read all of the writing. */
    legible: boolean;
    /** The points awarded and why, or null when grading didn't happen or failed. */
    points: number | null;
    feedback: string;
    error?: string;
}

export type ReviewItem = NameItem | AnswerItem | ResponseItem;

export type Verdict = "marked" | "ambiguous" | "blank";

/** The run's thresholds: a fill above `mark` reads as marked, below `blank` as blank. */
export interface ReviewThresholds {
    mark: number;
    blank: number;
}

export interface ReviewFile {
    thresholds: ReviewThresholds;
    items: ReviewItem[];
}

export type ReviewDecision = { skip: true } | { name: string } | { answer: number[] } | { points: number };

export const REVIEW_FILE = "review.json";
export const SKIP = "-";
export const NO_ANSWER = "none";
export const SKIPPED_IN_REVIEW = "skipped during review";

const letters = (choices: readonly number[]) => choices.map((c) => CHOICE_LETTERS[c]).join("");
/** Keeps an OCR'd name on one prompt line and away from the prompt's closing marker. */
const clean = (s: string) => s.replace(/[\r\n>]+/g, " ");

export function reviewPrompt(item: ReviewItem, total: number): string {
    const head = `Review ${item.id}/${total} [${item.image}]`;
    if (item.kind === "name") {
        const files = item.files.join(", ");
        return item.ocr !== null
            ? `${head} name on [${files}] read as "${clean(item.ocr)}" (Enter keeps it, ${SKIP} skips the submission) > `
            : `${head} name on [${files}] couldn't be read: ${clean(item.error ?? "")} (type it, ${SKIP} skips the submission) > `;
    }
    if (item.kind === "response") {
        const of = `of ${item.maxPoints}`;
        const read = item.text === null ? `couldn't be read: ${clean(item.error ?? "")}` : `read as "${clean(item.text)}"${item.legible ? "" : " (partly illegible)"}`;
        const graded =
            item.points !== null
                ? `, graded ${item.points}/${item.maxPoints}${item.feedback ? `: ${clean(item.feedback)}` : ""} (Enter keeps it, a number ${of} replaces it`
                : `${item.text !== null && item.error ? `, not graded: ${clean(item.error)}` : ""} (type the points ${of}`;
        return `${head} Q${item.question} on ${item.file}: ${read}${graded}, ${SKIP} skips the submission) > `;
    }
    const marked = item.marked.length ? letters(item.marked) : "nothing";
    const unclear = item.unclear.map((c) => `${CHOICE_LETTERS[c]} (${item.fills[c]!.toFixed(2)})`).join(", ");
    return `${head} Q${item.question} on ${item.file}: marked ${marked}, unclear ${unclear} (letters, ${NO_ANSWER} for no answer, ${SKIP} skips the submission) > `;
}
export const REVIEW_PROMPT_RE = /^Review (\d+)\/(\d+) .* > $/;

export const reviewStartLine = (count: number, dir: string) => `review: ${count} item(s) to check, images in ${dir}\n`;
export const REVIEW_START_RE = /^review: (\d+) item\(s\) to check, images in (.+)$/;

export type ReviewParse = { decision: ReviewDecision } | { error: string };

/** Parses a reply to an item's prompt. */
export function parseReviewReply(item: ReviewItem, line: string): ReviewParse {
    const text = line.replace(/\s+/g, " ").trim();
    if (text === SKIP) return { decision: { skip: true } };
    if (item.kind === "name") {
        if (text) return { decision: { name: text } };
        if (item.ocr) return { decision: { name: item.ocr } };
        return { error: `type the student's name, or ${SKIP} to skip the submission` };
    }
    if (item.kind === "response") {
        if (!text && item.points !== null) return { decision: { points: item.points } };
        const n = Number(text);
        if (!text || !Number.isInteger(n) || n < 0 || n > item.maxPoints) {
            return { error: `type the points, a whole number from 0 to ${item.maxPoints}, or ${SKIP} to skip the submission` };
        }
        return { decision: { points: n } };
    }
    if (text.toLowerCase() === NO_ANSWER) return { decision: { answer: [] } };
    if (!text) return { error: `type the answer's letters, ${NO_ANSWER}, or ${SKIP} to skip the submission` };
    const set = new Set<number>();
    for (const ch of text.replace(/[\s,]/g, "").toUpperCase()) {
        const c = CHOICE_LETTERS.indexOf(ch);
        if (c < 0 || c >= item.choices) return { error: `"${ch}" isn't one of this question's choices (${CHOICE_LETTERS.slice(0, item.choices)})` };
        set.add(c);
    }
    return { decision: { answer: [...set].sort((a, b) => a - b) } };
}

/** The reply that gives `decision` (the inverse of parseReviewReply). */
export function reviewReply(decision: ReviewDecision): string {
    if ("skip" in decision) return SKIP;
    if ("name" in decision) return decision.name;
    if ("points" in decision) return String(decision.points);
    return decision.answer.length ? letters(decision.answer) : NO_ANSWER;
}

/** Names read on more than one submission (case-insensitive), as name → submissions' first files. */
export function duplicateNames(names: readonly { name: string; file: string }[]): Map<string, string[]> {
    const by = new Map<string, string[]>();
    for (const { name, file } of names) {
        const k = name.trim().toLowerCase();
        if (k) by.set(k, [...(by.get(k) ?? []), file]);
    }
    return new Map([...by].filter(([, files]) => files.length > 1));
}
