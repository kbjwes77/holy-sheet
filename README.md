# Test Sheet Grader

Grades scanned or photographed multiple-choice sheets and prints one CSV row per student.
See `Test Sheet Grader — Implementation Brief.md` for the full design.

```sh
bun install
# .env needs OPENROUTER_API_KEY and OPENROUTER_MODEL (no default model)
bun run grade.ts sheets.zip > grades.csv          # prompts for the key on stderr
bun run grade.ts sheets.zip --debug               # annotated images of every page
bun run grade.ts sheets.zip --mark 0.45 --blank 0.15
```

Exit codes: 0 all graded, 2 some submissions skipped (reasons on stderr, annotated images of
problem pages in `grade-<timestamp>/` next to the zip), 1 fatal.

## Development

```sh
bun test                    # unit, synthetic-sheet and end-to-end tests
bun run typecheck
bun run build:shared        # dist/shared/codec.mjs + layout.mjs for the browser generator
bun gen/make-fixture.ts out/ --students 6 --questions 20 --ambiguous 0.3   # fake sheets.zip + key.txt
bun gen/check-pages.ts --seed 7 --students 12 --debug out/debug            # decode + fill stats
```

`gen/` holds the reference sheet generator (`sheet.ts`), dummy tests and simulated students
(`dummy.ts`, `pencil.ts`), capture distortions (`distort.ts`) and the fixture builder.
