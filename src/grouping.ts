// Groups decoded pages into per-student submissions, in zip order.
import type { PagePayload } from "./codec.ts";

export interface GroupablePage {
    file: string;
    reasons: string[];
    payload?: PagePayload;
}

export interface Group<P extends GroupablePage> {
    pages: P[];
    /** Empty when the submission is valid. */
    reasons: string[];
    /** True for pages that came before the first page 1. */
    orphan: boolean;
}

/**
 * A page whose pageNumber is 1 starts a submission; following pages join it until the next
 * page 1. Pages whose QR couldn't be read have no page number, so they join the current
 * submission (making it invalid) rather than starting one.
 */
export function groupPages<P extends GroupablePage>(pages: readonly P[]): Group<P>[] {
    const groups: Group<P>[] = [];
    let current: Group<P> | undefined;
    for (const page of pages) {
        if (page.payload?.pageNumber === 1) {
            current = { pages: [page], reasons: [], orphan: false };
            groups.push(current);
        } else if (current) {
            current.pages.push(page);
        } else {
            const last = groups.at(-1);
            if (last?.orphan) last.pages.push(page);
            else groups.push({ pages: [page], reasons: [], orphan: true });
        }
    }
    for (const g of groups) g.reasons = g.orphan ? ["orphan page(s) before the first page 1"] : validate(g.pages);
    return groups;
}

function validate(pages: readonly GroupablePage[]): string[] {
    const reasons: string[] = [];
    for (const p of pages) for (const r of p.reasons) reasons.push(`${p.file}: ${r}`);
    const decoded = pages.flatMap((p) => (p.payload ? [p.payload] : []));
    const first = decoded[0];
    if (!first) return reasons;

    if (decoded.some((p) => p.totalPages !== first.totalPages || p.totalQuestions !== first.totalQuestions)) {
        reasons.push("pages disagree on total pages or total questions");
    }
    const numbers = pages.map((p) => p.payload?.pageNumber ?? "?");
    const expected = Array.from({ length: first.totalPages }, (_, i) => i + 1);
    if (numbers.join() !== expected.join()) {
        const seen = new Map<number, number>();
        for (const n of decoded) seen.set(n.pageNumber, (seen.get(n.pageNumber) ?? 0) + 1);
        const missing = expected.filter((n) => !seen.has(n));
        const dup = [...seen].filter(([, c]) => c > 1).map(([n]) => n);
        const parts = [`page sequence is ${numbers.join(",")}, expected ${expected.join(",")}`];
        if (missing.length) parts.push(`missing page(s) ${missing.join(",")}`);
        if (dup.length) parts.push(`duplicate page(s) ${dup.join(",")}`);
        reasons.push(parts.join("; "));
        return reasons;
    }
    // Question ranges must tile 0…totalQuestions−1.
    let next = 0;
    for (const p of decoded) {
        if (p.firstQuestionIndex !== next) {
            reasons.push(`page ${p.pageNumber} starts at question ${p.firstQuestionIndex + 1}, expected ${next + 1}`);
            return reasons;
        }
        next += p.questionsOnPage;
    }
    if (next !== first.totalQuestions) reasons.push(`pages cover ${next} of ${first.totalQuestions} questions`);
    return reasons;
}
