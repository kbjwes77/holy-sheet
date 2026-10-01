// Writes a fixture zip, its answer key and a manifest to a directory.
// Usage: bun gen/make-fixture.ts <outDir> [--seed N] [--students N] [--questions N] [--ambiguous P]
//        [--profiles clean,scan,scan-flipped,photo] [--drop-page-of N] [--duplicate-page-of N] [--orphan]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Profile } from "./distort.ts";
import { makeFixture } from "./fixture.ts";

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        seed: { type: "string", default: "1" },
        students: { type: "string", default: "6" },
        questions: { type: "string", default: "20" },
        ambiguous: { type: "string", default: "0" },
        profiles: { type: "string" },
        "drop-page-of": { type: "string" },
        "duplicate-page-of": { type: "string" },
        orphan: { type: "boolean", default: false },
    },
});
const out = positionals[0];
if (!out) {
    console.error("usage: bun gen/make-fixture.ts <outDir> [options]");
    process.exit(1);
}
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const fx = await makeFixture({
    seed: Number(values.seed),
    students: Number(values.students),
    questions: Number(values.questions),
    ambiguousRate: Number(values.ambiguous),
    profiles: values.profiles?.split(",") as Profile[] | undefined,
    dropPageOf: num(values["drop-page-of"]),
    duplicatePageOf: num(values["duplicate-page-of"]),
    orphan: values.orphan,
});
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "sheets.zip"), fx.zip);
writeFileSync(join(out, "key.txt"), fx.key + "\n");
writeFileSync(
    join(out, "manifest.json"),
    JSON.stringify({ files: fx.files, expected: fx.expected, expectedSkipped: fx.expectedSkipped, names: fx.students.map((s) => s.name) }, null, 2),
);
console.error(`wrote ${fx.files.length} pages for ${fx.students.length} students to ${out}`);
