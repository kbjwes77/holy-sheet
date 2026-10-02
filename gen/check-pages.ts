// Decodes every page of a generated fixture and compares the read marks with the simulated
// students' intended answers. Usage: bun gen/check-pages.ts [--seed N] [--students N]
// [--questions N] [--profiles a,b] [--figures P] [--debug dir]
import { mkdirSync, writeFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { parseArgs } from "node:util";
import { renderDebug } from "../src/debug.ts";
import { processPage } from "../src/pipeline.ts";
import type { Profile } from "./distort.ts";
import { makeFixture } from "./fixture.ts";

const { values } = parseArgs({
    options: {
        seed: { type: "string", default: "1" },
        students: { type: "string", default: "4" },
        questions: { type: "string", default: "20" },
        profiles: { type: "string" },
        ambiguous: { type: "string", default: "0" },
        figures: { type: "string", default: "0" },
        debug: { type: "string" },
    },
});
const fx = await makeFixture({
    seed: Number(values.seed),
    students: Number(values.students),
    questions: Number(values.questions),
    profiles: values.profiles?.split(",") as Profile[] | undefined,
    ambiguousRate: Number(values.ambiguous),
    figureRate: Number(values.figures),
});
const entries = unzipSync(fx.zip);
if (values.debug) mkdirSync(values.debug, { recursive: true });
let pagesOk = 0;
let wrongMarks = 0;
let problems = 0;
const fills = new Map<string, number[]>();
const note = (k: string, v: number) => fills.set(k, [...(fills.get(k) ?? []), v]);
for (const file of fx.files) {
    const t = performance.now();
    const res = await processPage(file.name, entries[file.name]!);
    const ms = (performance.now() - t).toFixed(0);
    const student = fx.students[file.student]!;
    const mismatches: string[] = [];
    for (const q of res.questions ?? []) {
        const want = student.responses[q.index]!.chosen;
        q.rings.forEach((r, j) => {
            const style = student.responses[q.index]!.marks.get(j) ?? "none";
            note(style, r.fill);
            if (style === "none" || style === "erased") note(`${style}:${file.profile}`, r.fill);
        });
        const nChoices = fx.dummy.test.questions[q.index]!.choices.length;
        if (q.choices !== nChoices) mismatches.push(`Q${q.index + 1} choices ${q.choices}≠${nChoices}`);
        if (want.join() !== q.marked.join()) mismatches.push(`Q${q.index + 1} read [${q.marked}] want [${want}] fills ${q.rings.map((r) => r.fill.toFixed(2)).join(" ")}`);
    }
    const expectProblem = student.hasAmbiguous;
    if (res.reasons.length) problems++;
    else pagesOk++;
    wrongMarks += mismatches.length;
    const tag = res.reasons.length ? (expectProblem ? "PROBLEM(expected)" : "PROBLEM") : mismatches.length ? "WRONG" : "ok";
    console.log(`${file.name} s${file.student} p${file.pageNumber} ${file.profile.padEnd(12)} ${ms}ms ${tag}`);
    for (const r of res.reasons) console.log(`    reason: ${r}`);
    for (const m of mismatches) console.log(`    ${m}`);
    if (values.debug) writeFileSync(`${values.debug}/${file.name.replace(/\//g, "_")}.png`, await renderDebug(res));
}
for (const [k, v] of [...fills].sort()) {
    v.sort((a, b) => a - b);
    const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))]!.toFixed(2);
    console.log(`fill ${k.padEnd(9)} n=${String(v.length).padEnd(5)} min ${q(0)}  p5 ${q(0.05)}  median ${q(0.5)}  p95 ${q(0.95)}  max ${q(1)}`);
}
console.log(`\n${pagesOk}/${fx.files.length} pages clean, ${problems} with problems, ${wrongMarks} wrong question reads`);
