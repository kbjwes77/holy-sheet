// The CLI's stderr conventions, shared by the CLI (which writes them) and the web grader (which
// drives the CLI as a subprocess and parses them). Browser-safe: no Node imports.
import { REVIEW_START_RE } from "./review.ts";

export const KEY_EXAMPLE = "A,AB,D";
export const keyPrompt = (questions: number) => `Answer key for ${questions} questions (e.g. ${KEY_EXAMPLE}): `;
const KEY_PROMPT_RE = /^Answer key for (\d+) questions \(e\.g\. A,AB,D\): /;
/** Key errors follow the prompt on the same line (stdin isn't echoed), indented by two spaces. */
export const keyErrorLine = (error: string) => `  ${error}\n`;

export const decodedLine = (i: number, n: number, file: string, problem: boolean) => `decoded ${i}/${n}: ${file}${problem ? " (problem)" : ""}`;
const DECODED_RE = /^decoded (\d+)\/(\d+): (.*?)( \(problem\))?$/;

export const skippedHeader = (orphan: boolean, files: string[]) => `skipped ${orphan ? "orphan pages" : "submission"} [${files.join(", ")}]:\n`;
export const skippedReasonLine = (reason: string) => `  - ${reason}\n`;
const SKIPPED_RE = /^skipped (orphan pages|submission) \[(.*)\]:$/;
const REASON_RE = /^ {2}- (.*)$/;

export const debugWrittenLine = (count: number, dir: string) => `wrote ${count} diagnostic image(s) to ${dir}\n`;
const DEBUG_WRITTEN_RE = /^wrote (\d+) diagnostic image\(s\) to (.+)$/;

export const FATAL_PREFIX = "fatal: ";

/** File name of a page's diagnostic image inside the debug directory. */
export function debugImageName(file: string): string {
    return `${file.replace(/[\\/:*?"<>|]/g, "_").replace(/\.[^.]+$/, "")}.png`;
}

export type StderrEvent =
    | { type: "log"; text: string }
    | { type: "prompt"; questions: number }
    | { type: "keyError"; text: string }
    | { type: "keyAccepted" }
    | { type: "reviewPrompt"; item: number; total: number }
    | { type: "reviewError"; item: number; text: string };

/** A review prompt at the start of the text; it ends at the first " > " (prompts keep ">" out of names). */
const REVIEW_PROMPT_START = /^Review (\d+)\/(\d+) [^\n]*? > /;

/**
 * Turns the CLI's stderr stream into events. Prompts have no trailing newline and stdin isn't
 * echoed, so whatever the CLI writes next lands on the same line: an indented error (a re-prompt
 * follows), the next prompt, or the next log line. Prompts are taken off the front of the
 * unterminated tail as soon as they are complete.
 */
export class StderrParser {
    private tail = "";
    /** The prompt last shown and not yet answered with an error. */
    private pending: { kind: "key" } | { kind: "review"; item: number } | null = null;

    push(chunk: string): StderrEvent[] {
        const events: StderrEvent[] = [];
        this.tail += chunk.replace(/\r\n/g, "\n");
        for (;;) {
            if (this.prompt(events)) continue;
            const nl = this.tail.indexOf("\n");
            if (nl < 0) break;
            const line = this.tail.slice(0, nl);
            this.tail = this.tail.slice(nl + 1);
            this.line(line, events);
        }
        return events;
    }

    /** Flushes an unterminated last line (e.g. the CLI exiting while a prompt waits). */
    end(): StderrEvent[] {
        const events: StderrEvent[] = [];
        if (this.tail) this.line(this.tail, events);
        else this.answered(events);
        this.tail = "";
        return events;
    }

    private prompt(events: StderrEvent[]): boolean {
        let m: RegExpExecArray | null;
        if ((m = KEY_PROMPT_RE.exec(this.tail))) {
            this.answered(events);
            this.pending = { kind: "key" };
            events.push({ type: "prompt", questions: Number(m[1]) });
        } else if ((m = REVIEW_PROMPT_START.exec(this.tail))) {
            this.answered(events);
            this.pending = { kind: "review", item: Number(m[1]) };
            events.push({ type: "reviewPrompt", item: Number(m[1]), total: Number(m[2]) });
        } else return false;
        this.tail = this.tail.slice(m[0].length);
        return true;
    }

    /** Output after a prompt other than an error line: the reply was accepted. */
    private answered(events: StderrEvent[]): void {
        if (this.pending?.kind === "key") events.push({ type: "keyAccepted" });
        this.pending = null;
    }

    private line(line: string, events: StderrEvent[]): void {
        if (this.pending && line.startsWith("  ")) {
            const text = line.trim();
            events.push(this.pending.kind === "key" ? { type: "keyError", text } : { type: "reviewError", item: this.pending.item, text });
            this.pending = null;
            return;
        }
        this.answered(events);
        if (line) events.push({ type: "log", text: line });
    }
}

export interface Skipped {
    orphan: boolean;
    files: string[];
    reasons: string[];
}

export interface StderrSummary {
    /** Pages decoded so far, and the total (0 before the first page). */
    decoded: number;
    pages: number;
    problemFiles: string[];
    skipped: Skipped[];
    fatal?: string;
    debugDir?: string;
    /** Where `--review` wrote review.json and the crops. */
    reviewDir?: string;
    /** The final "graded N, skipped M ..." line. */
    totals?: string;
}

/** Summarises complete stderr log lines (as emitted by StderrParser). */
export function summarizeStderr(lines: readonly string[]): StderrSummary {
    const s: StderrSummary = { decoded: 0, pages: 0, problemFiles: [], skipped: [] };
    let current: Skipped | undefined;
    for (const line of lines) {
        const reason = current && REASON_RE.exec(line);
        if (reason) {
            current!.reasons.push(reason[1]!);
            continue;
        }
        current = undefined;
        let m: RegExpExecArray | null;
        if ((m = DECODED_RE.exec(line))) {
            s.decoded = Number(m[1]);
            s.pages = Number(m[2]);
            if (m[4]) s.problemFiles.push(m[3]!);
        } else if ((m = SKIPPED_RE.exec(line))) {
            current = { orphan: m[1] === "orphan pages", files: m[2] ? m[2].split(", ") : [], reasons: [] };
            s.skipped.push(current);
        } else if ((m = DEBUG_WRITTEN_RE.exec(line))) {
            s.debugDir = m[2];
        } else if ((m = REVIEW_START_RE.exec(line))) {
            s.reviewDir = m[2];
        } else if (line.startsWith(FATAL_PREFIX)) {
            s.fatal = line.slice(FATAL_PREFIX.length);
        } else if (line.startsWith("graded ")) {
            s.totals = line;
        }
    }
    return s;
}
