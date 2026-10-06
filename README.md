# Test Sheet Grader

Grades scanned or photographed test sheets (multiple choice and free response) and prints one
CSV row per student. See `Test Sheet Grader — Implementation Brief.md` for the full design.

```sh
bun install
# .env needs OPENROUTER_API_KEY and OPENROUTER_MODEL (no default model)
bun run grade.ts sheets.zip > grades.csv          # prompts for the key on stderr
bun run grade.ts sheets.zip --test test.json      # key, points and free-response answers from the test's JSON
bun run grade.ts sheets.zip --debug               # annotated images of every page
bun run grade.ts sheets.zip --mark 0.45 --blank 0.15
bun run grade.ts sheets.zip --review              # confirm names, settle unclear marks and written answers
```

`--test` grades from the JSON the sheets were generated from, which needs an `answer` for every
question. The key, each question's `points` and the free-response model answers all come from
it, so the CLI doesn't prompt for a key. It's fatal if the JSON doesn't match the sheets (its
question count, which questions are free response, or an answer letter with no bubble). Sheets
with free-response questions can only be graded with `--test`. Without it the letter key works
as before, every question worth 1 point.

`score` and `total` are points: a multiple-choice question earns its points only when the marked
set matches the key exactly. Each free-response question adds three columns after `percent`:
`q<N>_points`, `q<N>_response` (the answer as transcribed) and `q<N>_feedback` (the grading
model's reason).

### Free-response grading

The grader crops each answer box from the page and sends it to the model twice:

1. **Transcribe.** The model reads the handwriting, with the question for context. It's told to
   keep the student's mistakes and to say when it can't read some of the writing.
2. **Grade.** The model compares the transcript with the question, model answer and rubric, and
   awards whole points from 0 to the question's `points`. It judges content only, ignoring
   spelling and grammar.

Both calls use `OPENROUTER_MODEL` at temperature 0 and share the name OCR's retries and
concurrency. A blank box scores 0 without a grading call.

Without `--review`, a box the model can't read, or a failed call, skips the submission with a
reason. With `--review`, every written answer becomes a review item instead.

Exit codes: 0 all graded, 2 some submissions skipped (reasons on stderr, annotated images of
problem pages in `grade-<timestamp>/` next to the zip), 1 fatal.

`--review` asks instead of skipping: a submission whose only problem is a mark too faint to
call, or a name OCR couldn't read, is kept. After the key, the CLI writes a crop of each name
box and each unclear question, plus `review.json`, to `grade-<timestamp>/review/`. It then
prompts once per item. For a name, Enter keeps the OCR'd name, or type the right one. For an
answer, type its letters or `none`. For a written answer, the prompt shows the transcript, the
points awarded and the reason. Enter keeps those points, or type others (a whole number up to
the question's points). A partly illegible answer is graded on the model's best reading, and one
that couldn't be graded needs the points typed. `-` skips the submission. Every graded name and
written answer is asked about, since a misread name files a score under the wrong student. A
written answer's crop is in the review folder with the others.

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
has one then every question must; the app then shows the grader's key line. Any question can
have `points`, a whole number from 1 to 100 (default 1). The key card's **test.json** button
downloads the JSON for the web grader. See `examples/ap-macro-unit-4.json` and the validator in
`gen/testdef.ts`.

### Free-response questions

A question with `"type": "Free Response"` has no `choices`. Students write their answer in a
full-width box instead. `type` defaults to `"Multiple Choice"`. See
`examples/free-response-demo.json`.

```json
{
  "type": "Free Response",
  "prompt": "Explain why a molecule of water (H2O) has a bent molecular shape rather than a linear shape.",
  "answer": "The two lone pairs on the central oxygen atom repel the bonds, pushing them closer together.",
  "rubric": "1 point: names the lone pairs. 1 point: explains that their repulsion bends the molecule.",
  "points": 2,
  "lines": 3
}
```

- **`answer`** (required) is the model answer the grader compares the student's with. A test
  with a free-response question is graded from its JSON, so every question then needs an
  `answer`, and there's no letter key line.
- **`rubric`** (optional) tells the grading model what earns each point. Without one, it awards
  points by how fully the answer gives the model answer's key ideas.
- **`lines`** (optional, 1–20, default 3) is the box's height: 2 grid rows (0.35 in) a line,
  with a faint rule between lines.
- `answer` and `rubric` go only to the grader, so they may use any characters, LaTeX included.
  Prompts still print in the PDF's fonts; LaTeX in a prompt prints as written.

**On the sheet,** a free-response question prints full width, never in a column: its numbered
prompt, then the box. The box starts no higher than row 8, below the QR. Its rows have no
timing markers. Page 1's instruction line mentions the boxes. A page with a box uses QR format
6, which is format 4 plus each box's first row and row count. To fit that format, a test with
free-response questions can't have a single-choice question.

**With a separate answer sheet,** the question pages print the prompt and "Write your answer in
box N on the answer sheet." The answer sheet keeps test order. Each run of multiple-choice
questions between boxes is its own block of bubble rows, as few rows as hold it (rounded to
whole fives past five). Each box gets a row with its number, then the box itself, with a blank
row between items. A page with a box uses QR format 7, which records each run's first row and
rows per block and each box's rows.

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
beside it and the prompt's first line on a light grey rectangle.

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

### Separate answer sheet

The **Separate answer sheet** switch (beside Generate; off by default, remembered in the
browser) splits the test into question pages followed by an answer sheet, in one PDF. Changing it
regenerates the shown sheet. The JSON format is the same either way.

- **Question pages** are never scanned: no QR, corner squares, timing marks or Name box. Page 1
  has the test name and a line telling students to mark the answer sheet. Every page has two
  columns, filled newspaper-style: down the left, then the right, then the next page. A question
  never splits; one taller than a whole column is an error. Lines are 14 units apart rather than
  on the grid, and short choices share a line (all on one, or in a grid read across) when they
  fit. Figures line up with the prompt text. One wider than that starts at the column's edge, and
  one wider than the column shrinks to fit it.
- **The answer sheet** has page 1's header (test name, Name/Period/Date and instructions, under
  "ANSWER SHEET"), the QR, corner squares and timing marks. Each question is one row (rows 9–57)
  with its bubbles side by side, 0.72 of a cell across. The bubbles have a faint letter inside
  and are white inside, so the band never shades them. Rows go down a block, then the next,
  with as many blocks across as fit the widest question (3 for 8 choices, 5 for 5, 6 for 4).
  Each block holds a whole number of fives, as few as needed. Every other group of five rows sits
  on a light grey band.
- **Blank page.** After an odd number of question pages, a page marked "This page is
  intentionally left blank." follows them. Printed double-sided, the answer sheet then starts on
  a sheet of its own, so the questions can stay stapled while the answer sheet is handed out,
  and later scanned, loose.
- **Pages.** "Page X of Y" counts all pages, including the blank one. The QR's page numbers count only answer sheet pages,
  so a student's scan is just their answer sheet. Questions with equal choice counts encode as
  runs, so a test of 4-choice questions (up to 256) fits one answer page. The QR is capped at
  version 3 (1.0 mm modules, 42 bytes). With mixed choice counts that caps a page at 95
  questions, and further questions start a new answer page. The 16-page limit applies to the
  answer sheet only.
- **Grading.** The QR payload is format 5. The grader reads format 4 and format 5 sheets alike.
  A question page scanned by mistake has no QR, so it's flagged and its
  submission skipped, as for any page without a QR.

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
`.zip` or a set of PNG/JPG page images (zipped in the browser, in file-name order) and the
test's JSON (the Sheet Generator's **test.json** button), then Grade. The JSON is required. The
page checks it, needs an `answer` for every question, and shows its question count,
free-response count and total points. The server (`web/grader-api.ts`) writes both files to a
temp directory and runs `bun run grade.ts <zip> --test <json>` on them as a subprocess, so sheets
are processed exactly as from the terminal. It streams the CLI's stderr to the page (progress,
skipped submissions). The page always runs with `--review`:
once the sheets are read it shows each name crop beside its OCR'd name, which you can edit, and
warns about duplicate names. Each unclear question appears as a crop where you click the bubbles
to choose the answer. Each written answer shows its box's crop, the transcript, the grading
reason and the points, which you can change. Any submission can be skipped. Grade with these
sends the replies to the CLI's prompts. It renders the CLI's CSV as a sortable table
(download/copy the exact CSV). Each free-response question gets a column of points; open a cell
for the transcript and reason. The page also shows the diagnostic images. The API also accepts
a bare zip body without a test (the CLI then prompts for a letter key), and a multipart form
with `zip` and `test` files. The server listens on
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
bun gen/check-pages.ts --answer-sheet --questions 120                       # the same, separate answer sheets
```

`gen/` holds the reference sheet generator (`sheet.ts`; `booklet.ts` for a separate answer sheet), dummy tests and simulated students
(`dummy.ts`, `pencil.ts`), capture distortions (`distort.ts`) and the fixture builder.
