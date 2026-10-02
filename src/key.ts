// Answer key parsing and prompting.
import { createInterface } from "node:readline";
import { CHOICE_LETTERS } from "./layout.ts";
import { keyErrorLine, keyPrompt } from "./report.ts";

export type Key = number[][];

export class KeyAbortError extends Error {
    override name = "KeyAbortError";
}

export type KeyParse = { key: Key } | { error: string };

/**
 * Parses `A,AB,D,E`: one comma-separated entry per question, letters concatenated for
 * multi-select. Case and whitespace are ignored; each entry is a set. `maxChoices[i]` is the
 * largest ring count detected for question i.
 */
export function parseKey(line: string, maxChoices: readonly number[]): KeyParse {
    const entries = line.split(",").map((e) => e.replace(/\s+/g, "").toUpperCase());
    if (entries.length !== maxChoices.length) {
        return { error: `the key has ${entries.length} entries, but the test has ${maxChoices.length} questions` };
    }
    const key: Key = [];
    for (const [i, entry] of entries.entries()) {
        if (!entry) return { error: `question ${i + 1} has no answer` };
        const set = new Set<number>();
        for (const ch of entry) {
            const c = CHOICE_LETTERS.indexOf(ch);
            if (c < 0) return { error: `question ${i + 1}: "${ch}" is not a choice letter` };
            if (c >= maxChoices[i]!) {
                return { error: `question ${i + 1}: "${ch}" is out of range; it has ${maxChoices[i]} choice(s) (${CHOICE_LETTERS.slice(0, maxChoices[i])})` };
            }
            set.add(c);
        }
        key.push([...set].sort((a, b) => a - b));
    }
    return { key };
}

/** Lines from stdin, opened on first use and shared by every prompt of a run. */
export class LineReader {
    private lines?: AsyncIterator<string>;
    private close?: () => void;

    constructor(private readonly input: NodeJS.ReadableStream = process.stdin) {}

    /** The next line, or undefined once the input is closed. */
    async next(): Promise<string | undefined> {
        if (!this.lines) {
            const rl = createInterface({ input: this.input, terminal: false });
            this.lines = rl[Symbol.asyncIterator]();
            this.close = () => rl.close();
        }
        const r = await this.lines.next();
        return r.done ? undefined : r.value;
    }

    dispose(): void {
        this.close?.();
    }
}

/**
 * Writes `prompt` on stderr (stdout is reserved for CSV) and reads lines until `parse` accepts
 * one; each rejection is written as an indented error line after the prompt.
 */
export async function ask<T extends object>(
    lines: LineReader,
    write: (s: string) => void,
    prompt: string,
    parse: (line: string) => { error: string } | T,
    closed: string,
): Promise<T> {
    for (;;) {
        write(prompt);
        const line = await lines.next();
        if (line === undefined) throw new KeyAbortError(closed);
        const parsed = parse(line);
        if ("error" in parsed) write(keyErrorLine(parsed.error));
        else return parsed;
    }
}

/** Prompts until a valid key is entered. */
export async function promptKey(maxChoices: readonly number[], lines: LineReader, write: (s: string) => void): Promise<Key> {
    const parsed = await ask<{ key: Key }>(lines, write, keyPrompt(maxChoices.length), (line) => parseKey(line, maxChoices), "no answer key given (stdin closed)");
    return parsed.key;
}
