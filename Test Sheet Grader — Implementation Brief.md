# Test Sheet Grader — Implementation Brief

Sep 30, 2026 · @John Wesley · revised Sep 30, 2026 with the decisions from the design Q&A

## Goal

Build a headless Bun + TypeScript CLI that grades scanned multiple-choice test sheets and prints one CSV row per student to stdout. No browser is involved.

Usage: `bun run grade.ts <sheets.zip> [--debug] [--mark <ratio>] [--blank <ratio>]`. The tool extracts the zip, decodes every image in it, groups pages into per-student submissions, prompts once for the answer key, grades each submission, and writes the CSV. Problem submissions are skipped and reported on stderr.

Scope is the decoder plus a reference sheet generator. The generator in this repo is a reference/test implementation built from the same `LayoutSpec` and codec; the user's browser generator will adopt the shared modules (see *Sharing with the browser generator*).

## Sheet layout and inputs

The input is a zip of page images (JPEG or PNG). Ignore directories, non-image files, dotfiles and `__MACOSX/`. Keep the zip's stored entry order, because page grouping depends on it. Do not sort the entries. PDFs are not accepted; convert them to images before zipping.

Images may come from copier/ADF scanners **or phone photos** (perspective, uneven light, background around the page). Registration must handle both.

Each sheet is US Letter, laid out in canonical page units of 1/100 in (850 × 1100) with a 25-unit margin. The printable area (800 × 1050) is divided evenly into a grid of 46 columns by 60 rows (cells ≈ 17.39 × 17.5 units). Columns and rows are 1-based, matching the codec.

```
cols: 1-2  3   4 ........................ 35  36 37 ...... 44 45-46
row 1 [■■]     Name ________________________     [ QR 8×8  ]  [■■]
    2 [■■]    |                            |     [ cells   ]  [■■]
  3-4         |____________________________|     [         ]
    5          Period   Test name      Date      [         ]
  6-8         [______] [____________] [______]   [_________]
    9  ─────────────────── header divider ──────────────────────
10-57 ▬  (free-form question content)
      ▬  1  (A) (B) (C) (D)      ← ring row: marker in col 1, number in cols 2–3
59-60 [■■]                                                    [■■]
```

- **Corner squares.** Four solid 2 × 2-cell squares in the corners of the printable area (cols 1–2 / 45–46, rows 1–2 / 59–60). They anchor a full-page homography for phone photos. Orientation comes from the QR code, so no notch is needed.
- **Header (fixed size).** Every page has the QR code in cols 37–44, rows 1–8 (quiet zone included). The QR symbol itself is drawn as a square of side 6 cell heights centred in that rectangle, whatever its version, so its corners have fixed page coordinates. Page 1 also has four open handwritten boxes: Name (first and last, cols 4–35, rows 2–4), Period (cols 4–9), Test name (cols 11–28) and Date (cols 30–35), the last three in rows 6–8. **Only Name is read by the grader**; Period, Test name and Date are for the teacher's reference and are not OCR'd. A divider is drawn on row 9.
- **Body (free-form).** Rows 10–57 (row 58 is left empty to keep markers clear of the bottom corner squares). Question content is free-form. Below each question is a row of response rings aligned to the grid. That row also has a solid marker in col 1 (1 cell wide × ½ cell tall, centred on the cell), so the markers form an OMR-style timing track. Rings always start at col 4. A question has 1–8 rings, lettered A, B, C… from left to right, with light-gray letters printed inside.
- **Ring geometry.** Diameter 0.8 × cell width, outline stroke 1.5 units. Spacing is an even spread with a capped pitch, snapped to whole columns: `pitch(n) = min(8, floor(40 / (n − 1)))` columns, and ring *i* (0-based) is centred on col `4 + i·pitch`. That gives a pitch of 8 for up to 6 choices, 6 for 7 and 5 for 8; the last ring never passes col 44.

All of these constants live in a typed `LayoutSpec` in `src/layout.ts`, which is the source of truth for both the grader and every generator.

## QR payload codec

The payload is bit-packed MSB-first in field order and the final byte is zero-padded. Encode it as one QR byte-mode segment at error-correction level M. Implement it as `pack`/`unpack` in `src/codec.ts`, a dependency-free module the user's generator will import as well.

| Field | Bits | Stored value |
| --- | --- | --- |
| Format version | 4 | `1` |
| Total pages | 5 | 0–16 |
| Page number (1-based) | 5 | 0–16 |
| Total questions | 9 | 0–256 |
| Questions on this page | 9 | 0–256 |
| First question index (0-based) | 9 | 0–255 |
| Row marker per question on this page | 6 each | grid row − 1 (rows 1–60) |

The header is 41 bits. The codec's worst case is 256 questions on one page: 1,577 bits, or 198 bytes, which fits QR version 10-M. With one question per ring row the layout allows at most 48 questions per page (41 + 48 × 6 = 329 bits, 42 bytes), which fits version 4-M. The row array has no length prefix because `questionsOnPage` gives its length.

`unpack` must reject the payload in any of these cases: the version is unknown, `pageNumber` is 0 or greater than `totalPages`, `firstQuestionIndex + questionsOnPage` exceeds `totalQuestions`, or the byte length doesn't match the computed bit count.

## Per-image pipeline

Each image goes through the steps below. Any failure marks that page as a problem, with a reason string.

1. **Load.** Use `sharp`: apply EXIF orientation with `.rotate()`, convert to grayscale, and normalize with black anchored at the true minimum (`lower: 0`; the default 1st percentile turns the light ring letters black on a nearly empty page). Downscale to about 2,000 px on the long edge.
2. **Decode QR.** Use `zxing-wasm`'s `readBarcodes` with `formats: ['QRCode']`, `tryHarder: true`, and `maxNumberOfSymbols: 1`. Try the expected header region first, then the full image. Load the `.wasm` from `node_modules` via `prepareZXingModule` so the tool works offline and never hits a CDN. Pass `result.bytes` to `unpack`.
3. **Register the page.** Use the QR corner `position` (the symbol's outer corners) to get an initial page-to-image transform; it also reveals any rotation, including 180°. Find the corner squares one at a time, nearest the QR first, refitting after each, then the left-margin markers, and refit by least-squares DLT over all of these points with outlier rejection, because QR corners alone extrapolate poorly across the page. Fit an affine transform while the anchors don't yet span at least half the page in both directions; a full homography fitted to clustered points invents large perspective terms. Warp to a canonical rectified image at a fixed scale (about 1.5 px per page unit, ~26 px per cell).
4. **Find markers.** Scan the marker column for dark blobs and map them to grid rows. The detected set must match the QR row array exactly (same count, same rows).
5. **Find rings.** In each marker row, scan from the ring start column to the right edge. Count the ring outlines, then check that the detected centers match the layout spacing formula for that count. Each ring's centre is refined locally, which absorbs paper curl the homography can't model. Record each question's choice count.
6. **Measure fill.** Darkness is measured relative to the local paper level (a dilated block-maximum background). A ring's fill is the mean darkness inside its inner disk (70 % of the radius), divided by the darkness of the page's printed markers, then corrected for the page's blank level: `fill = (raw − b) / (1 − b)`, where `b` is the lower quartile of the page's ring fills (the minimum when there are fewer than 6 rings), capped at 0.25 (0.2). That removes the outline and letter bleed that blur and low resolution add, which varies per capture. A fill above `markThreshold` (default 0.45) means marked and below `blankThreshold` (default 0.15) means blank. Anything in between is ambiguous, which makes the page a problem. Both thresholds are configurable (`--mark`, `--blank`) and need tuning against real scans.
7. **OCR the name (page 1 only).** Crop the Name box from the rectified image with a little padding. Send it as a base64 PNG data URI to OpenRouter's OpenAI-compatible chat completions endpoint. Ask for strict JSON `{name}`, and read the key and model from `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. There is no default model: both variables are required, and a missing one is a fatal error. Validate that the name is non-empty. Cap concurrency (around 4) and retry transient failures with backoff.

Implement registration and blob detection directly in TypeScript on raw grayscale buffers using `sharp`'s `.raw()` output, with no OpenCV dependency.

## Grouping pages into submissions

Walk the decoded pages in zip entry order. A page whose `pageNumber` is 1 starts a new submission, and each following page joins it until the next page 1. Pages that come before the first page 1 are orphans and get reported as a problem.

A submission is valid only if all of these hold: its pages are numbered 1…`totalPages` consecutively, every page has the same `totalPages` and `totalQuestions`, and the page question ranges (`firstQuestionIndex` + `questionsOnPage`) cover 0…`totalQuestions − 1` contiguously with no gaps or overlaps. Any failed page, or any failed check, skips the whole submission.

Assume one test per zip: every submission must share the same `totalQuestions`, and a mismatch is a fatal error before prompting.

## Answer key and grading

Prompt for the key once, after all images are decoded, since `totalQuestions` is known by then. OCR requests can keep running while the prompt waits.

The key is one line: comma-separated entries, one per question, with letters concatenated for multi-select answers. For example, `A,AB,D,E` means Q1 = A, Q2 = A and B, Q3 = D, Q4 = E. When parsing, trim whitespace, ignore case, and treat each entry as a set of letters. The entry count must equal `totalQuestions`, and each letter must fall within the largest choice count detected for that question. On error, print the reason and re-prompt.

Write the prompt to **stderr** and read stdin with `node:readline` (`output: process.stderr`). Do not use Bun's global `prompt()`, which writes to stdout and would corrupt redirected CSV.

A question is correct only when the set of marked letters exactly equals the key's set. Blank or partial answers are wrong. The score is the number of correct questions, the total is `totalQuestions`, and the percent is score ÷ total × 100, rounded to one decimal place.

## Output and error handling

Stdout carries only RFC 4180 CSV: a header row, then one row per valid submission in zip order. Period, test name and date are not read, so they are not in the CSV.

```csv
student_name,score,total,percent
Jane Doe,18,20,90.0
```

Problem submissions are skipped entirely. For each one, write a line to stderr naming its files and every reason, then finish with a count of graded vs skipped submissions. Skip reasons include:

- QR missing or invalid
- Orphan pages, or a broken, missing or duplicate page sequence
- Marker rows that don't match the QR
- Ring counts or positions that don't match the layout
- An ambiguous mark
- OCR failure or an empty name

Exit with code 0 when everything was graded, 2 when any submission was skipped, and 1 on fatal errors (bad zip, mixed tests, missing `OPENROUTER_API_KEY` or `OPENROUTER_MODEL`).

### Diagnostic images

Annotated images of problem pages are **always** written. `--debug` writes annotated images of every page. Both go to one new directory next to the zip, named with the current timestamp (e.g. `grade-2026-09-30T14-05-12/`), created only when there is something to write. Each image is the rectified page with the detected corners, markers, rings, fill ratios and verdicts overlaid (or the original image with the reason, when registration failed). No JSON measurement files.

## Project structure and dependencies

Runtime dependencies are `zxing-wasm`, `sharp`, and `fflate` (in-memory unzip that preserves entry order). Dev dependencies are `qrcode` (used by the reference generator) and `@types/bun`. Use TypeScript in strict mode.

Modules under `src/`: `cli.ts`, `run.ts` (the IO-free orchestrator), `zip.ts`, `image.ts`, `qr.ts`, `codec.ts`, `layout.ts`, `geometry.ts`, `registration.ts`, `marks.ts`, `pipeline.ts`, `ocr.ts`, `grouping.ts`, `key.ts`, `grade.ts`, `csv.ts`, `debug.ts`. Put OCR behind an interface so tests can mock it.

The reference generator and fixture tools live under `gen/`: the sheet renderer (`LayoutSpec` → SVG pages with QR and question content), a dummy-test generator with answer keys, a simulated pencil-mark renderer, and image distortions.

### Sharing with the browser generator

The project is standalone in this directory. `bun run build:shared` uses `bun build` to emit `dist/shared/codec.mjs` and `dist/shared/layout.mjs` (dependency-free ES modules) for the browser generator to vendor.

## Testing

Use `bun test` throughout:

- **Codec.** Round-trip property tests at boundary values, including 256 questions on one page.
- **Synthetic sheets.** The reference generator renders dummy tests; simulated students fill rings with pencil-like marks. Distort the pages with ±5° rotation, perspective skew, scaling, blur, noise, uneven lighting, JPEG compression and 180° flips, then check that decoding recovers every mark.
- **End to end.** Build a zip of simulated submissions, run the full grader with mocked OCR and a known key, and compare the CSV with the expected scores; include problem submissions (ambiguous marks, missing and orphan pages).
- **Grouping and keys.** Unit tests for grouping edge cases and key parsing.
- **Real scans.** Run a supplied set of real scans as an end-to-end fixture once available.

## Open items from the user

- [x] `LayoutSpec` values, including the ring-spacing formula (proposed and approved, above)
- [x] Maximum number of choices per question: 8 (A–H)
- [ ] A sample zip of real scans for threshold tuning
- [ ] `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` in `.env` (no default model)
