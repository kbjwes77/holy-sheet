# Test Sheet Grader

Grades scanned or photographed multiple-choice sheets and prints one CSV row per student.
See `Test Sheet Grader — Implementation Brief.md` for the full design.

```sh
bun install
# .env needs OPENROUTER_API_KEY and OPENROUTER_MODEL (no default model)
bun run grade.ts sheets.zip > grades.csv          # prompts for the key on stderr
bun run grade.ts sheets.zip --debug               # annotated images of every page
bun run grade.ts sheets.zip --mark 0.45 --blank 0.15
bun run grade.ts sheets.zip --review              # confirm names, settle unclear marks
```

Exit codes: 0 all graded, 2 some submissions skipped (reasons on stderr, annotated images of
problem pages in `grade-<timestamp>/` next to the zip), 1 fatal.

`--review` asks instead of skipping: a submission whose only problem is a mark too faint to
call, or a name OCR couldn't read, is kept. After the key, the CLI writes a crop of each name
box and each unclear question, plus `review.json`, to `grade-<timestamp>/review/`. It then
prompts once per item. For a name, Enter keeps the OCR'd name, or type the right one. For an
answer, type its letters or `none`. `-` skips the submission. Every graded name is asked about,
since a misread name files a score under the wrong student.

## Sheet Generator (web)

Paste or load a test as JSON, then preview, print or download a PDF of the answer sheet.

```sh
bun run web          # dev server at http://127.0.0.1:3000
bun run build:web    # dist/web/sheet-generator.html: one file, opens straight from disk
```

The server listens on 127.0.0.1 only. Set `HOST` to also listen on one more address, e.g. a
Tailscale IP: add `HOST=100.93.67.7` to `.env` (a variable set in the shell takes precedence).
`PORT` works the same way. Anyone who can reach that address can run the grader with your
OpenRouter key.

`web/index.html` is the source page and can't be opened directly (browsers block its
TypeScript module on `file://`). The format is
`{ "test": "...", "questions": [{ "prompt": "...", "choices": ["...", ...], "answer": "B" }] }`.
There must be 1–256 questions, each with 2–8 choices. `answer` is optional, but if any question
has one then every question must; the app then shows the grader's key line. See
`examples/ap-macro-unit-4.json` and the validator in `gen/testdef.ts`.

### Layout

Questions print in two columns, each 3.3 in wide: down the left (cols 4–22), then the right
(cols 26–44), with a grey hairline between them. A question prints full width when any of its
choices would wrap in a column, or a figure is wider than a column. So does a column question
with no other beside it. A page has at most one band of columns. Full-width questions can go above
it, and once a full-width question follows the columns, the rest of that page prints full width,
including questions that would fit a column. A blank row, a grey hairline across the page and
another blank row separate the columns from the full-width questions below them. A
full-width question that doesn't fit below the columns starts the next page. The columns split
where they come out closest in height, any extra question going left. The right column starts no
higher than row 8, below the QR.

Each question's number prints in white bold on a dark grey rectangle, with its prompt indented
beside it.

Page 1's header is the test name (cols 4–35, rows 1–2: one line at 16 pt, or two smaller lines,
down to 10 pt, when it wraps), the Name, Period and Date boxes (rows 4–6, labelled on row 3) and
one line of instructions (row 7). Its questions start on row 9, a blank row below the
instructions. The QR's top edge is level with the corner squares; the page margin is its top
quiet zone. "Page X of Y" prints in the footer, right of the test name. Later pages have no
header, so their first question's prompt starts as high as row 1, beside the top-left corner
square, and its first choice lands on row 4, the first row with a timing marker.

Every bubble row has one timing marker in col 1, whichever column its bubbles are in (col 5 for
full-width and left questions, col 27 for right ones). The QR payload (format 4) records each
question's column and a bubble-row mask per column. To keep the QR at version 2 (1.07 mm
modules), a page holds at most 14 questions when it has two columns. Sheets printed with the
previous layouts (format 2, single column; format 3, header a row lower) are rejected with a
request to reprint.

### Figures

A question can show SVG drawings (graphs, diagrams) and tables between its prompt and its
choices. Define each figure once, by id, in a top-level `"figures"` object (by convention at the
end of the file), and list the ids in the question's `"figures"` array. A figure can be shared by
several questions. See `examples/figures-demo.json`.

```json
"questions": [{ "prompt": "Using the graph, …", "figures": ["lf"], "choices": ["…", "…"] }],
"figures": {
  "lf":    { "type": "svg", "content": "<svg viewBox=\"0 0 260 200\">…</svg>", "width": 2.6, "caption": "Figure 1" },
  "bonds": { "type": "table", "content": "<table><tr><th>Bond</th><th>Price</th></tr>…</table>" }
}
```

- **Size.** `width` is in inches. Without it, an SVG prints at its own `width`/`height` (96 px per
  inch, or its `viewBox`), and a table is as wide as its text. Anything wider than the text column
  (7.13 in) is scaled down to fit. `caption` prints small and centred under the figure.
- **Placement.** Figures sit side by side, left to right, and wrap to a new line when the next one
  doesn't fit. Each line takes whole grid rows, so no bubble shares a row with a figure. A figure
  up to 3.3 in wide fits a column; a wider one prints its question full width. A full-width
  question whose figures each fit a column prints them flush right beside its prompt and choices
  instead, when no choice wraps there and that takes fewer rows. On pages 2+, rows
  1–7 are narrower for full-width questions because they sit beside the QR, and a figure line that
  won't fit there starts at row 8.
- **SVG rules.** Content must be one `<svg>` with a `viewBox` or a `width` and `height`.
  - **Allowed:** shapes, paths, `text`/`tspan`, `g`, `defs`, gradients, clip paths, markers,
    `use`, presentation attributes and `style="…"`.
  - **Not allowed, each reported as an error:**
    - `<style>` blocks and `class`;
    - scripts and `on…` attributes;
    - `foreignObject`, images, links, filters, masks, patterns, animation and nested `<svg>`;
    - references outside the figure;
    - fonts other than Arial/Helvetica, Times or Courier (the only fonts the PDF has);
    - characters those fonts can't print.
  - **Dropped without comment:** `title`, `desc`, `metadata` and editor attributes (Inkscape,
    Sodipodi, `data-*`). They don't print.
  - **Ids:** each placement prefixes the figure's ids, so two figures on a page can't clash.
- **Tables** are drawn as SVG lines and text, so the preview and the PDF match.
  - **Elements:** `<table>`, `<caption>` (printed above), `<thead>`/`<tbody>`, `<tr>`, `<th>`
    (bold, shaded) and `<td>`.
  - **Extras:** `colspan`/`rowspan`, `align` or `style="text-align: …"`, and inline `<b>`,
    `<i>`, `<sub>`, `<sup>`.
  - **Defaults:** numbers are right-aligned, other text is left-aligned, and headers are centred.
  - **Rules:** every cell is one line with full borders. Tags must be closed, and common HTML
    entities work. Other tags and attributes are errors, apart from `border`, `cellpadding` and
    `cellspacing` on `<table>`, which are ignored.
- A figure that no question uses doesn't block the sheet; the generator shows a note.

## Grader (web)

A GUI for the CLI at `http://127.0.0.1:3000/grader` (same `bun run web` server). Choose a
`.zip` or a set of PNG/JPG page images (zipped in the browser, in file-name order), optionally
paste the key or load `key.txt`, then Grade. The server (`web/grader-api.ts`) writes the zip to
a temp directory and runs `bun run grade.ts` on it as a subprocess, so sheets are processed
exactly as from the terminal. It streams the CLI's stderr to the page (progress, key prompt,
skipped submissions) and writes the key to the CLI's stdin. The page always runs with `--review`:
once the sheets are read it shows each name crop beside its OCR'd name, which you can edit, and
warns about duplicate names. Each unclear question appears as a crop where you click the bubbles
to choose the answer, and any submission can be skipped. Grade with these sends the replies to
the CLI's prompts. It renders the CLI's CSV as a sortable table (download/copy the exact CSV) and
shows the diagnostic images. The server listens on
127.0.0.1 only (plus `HOST` if set), refuses cross-origin POSTs, and keeps each run's files for 2 hours. The
OpenRouter settings come from `.env` as for the CLI and never reach the browser. The page
needs the server, so it has no standalone build.

The CLI's stderr formats live in `src/report.ts` and the review prompts and replies in
`src/review.ts`. Both are shared by the CLI and the page. Each reply the page sends names the
prompt it answers (`?at=key` or `?at=<item>`), and the server accepts it only while that prompt is
waiting. So when a request stalls and the page retries it, a late copy can't answer a later
prompt.

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
