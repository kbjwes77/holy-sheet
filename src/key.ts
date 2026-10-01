// Answer key parsing and prompting.
import { createInterface } from "node:readline";
import { CHOICE_LETTERS } from "./layout.ts";

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

/** Prompts on stderr (stdout is reserved for CSV) until a valid key is entered. */
export async function promptKey(
    maxChoices: readonly number[],
    input: NodeJS.ReadableStream = process.stdin,
    write: (s: string) => void = (s) => process.stderr.write(s),
): Promise<Key> {
    const rl = createInterface({ input, output: process.stderr, terminal: false });
    const lines = rl[Symbol.asyncIterator]();
    try {
        for (;;) {
            write(`Answer key for ${maxChoices.length} questions (e.g. A,AB,D): `);
            const next = await lines.next();
            if (next.done) throw new KeyAbortError("no answer key given (stdin closed)");
            const parsed = parseKey(next.value, maxChoices);
            if ("key" in parsed) return parsed.key;
            write(`  ${parsed.error}\n`);
        }
    } finally {
        rl.close();
    }
}
