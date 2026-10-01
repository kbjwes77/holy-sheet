// Scoring: a question is correct only when the marked set equals the key's set.
import type { Key } from "./key.ts";

export interface Score {
    score: number;
    total: number;
    /** score ÷ total × 100, one decimal place. */
    percent: string;
}

export function scoreAnswers(marked: readonly (readonly number[])[], key: Key): Score {
    let score = 0;
    key.forEach((want, i) => {
        const got = [...(marked[i] ?? [])].sort((a, b) => a - b);
        if (got.length === want.length && got.every((c, j) => c === want[j])) score++;
    });
    const total = key.length;
    const percent = total ? (Math.round((score / total) * 1000) / 10).toFixed(1) : "0.0";
    return { score, total, percent };
}
