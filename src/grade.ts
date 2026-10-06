// Scoring: a multiple-choice question earns its points only when the marked set equals the key's
// set; a free-response question earns the points its grading awarded.
import type { GradingKey } from "./key.ts";

export interface Score {
    score: number;
    total: number;
    /** score ÷ total × 100, one decimal place. */
    percent: string;
}

/**
 * `answers[i]` is the marked choices of a multiple-choice question, or the points awarded to a
 * free-response one.
 */
export function scoreAnswers(answers: readonly (readonly number[] | number | undefined)[], key: GradingKey): Score {
    let score = 0;
    let total = 0;
    key.forEach((entry, i) => {
        total += entry.points;
        const a = answers[i];
        if (entry.type === "free") {
            if (typeof a === "number") score += Math.max(0, Math.min(entry.points, a));
            return;
        }
        const got = [...(Array.isArray(a) ? a : [])].sort((x, y) => x - y);
        const want = entry.answer;
        if (got.length === want.length && got.every((c, j) => c === want[j])) score += entry.points;
    });
    const percent = total ? (Math.round((score / total) * 1000) / 10).toFixed(1) : "0.0";
    return { score, total, percent };
}
