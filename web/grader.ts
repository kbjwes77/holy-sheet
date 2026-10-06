// Grader UI: a front end for the grading CLI. The sheets go to the local server as one zip
// (picked images are zipped here, in file-name order) with the test's JSON, the server runs
// `bun run grade.ts --test` on them (web/grader-api.ts) with --review and streams the CLI's
// stderr back. This page answers the CLI's review prompts (names, unclear marks and written
// answers' points) and renders its CSV as a table.
import { zipSync } from "fflate";
import { parseSheetJson } from "../gen/testdef.ts";
import { CSV_HEADER, FREE_COLUMN_RE, parseCsv } from "../src/csv.ts";
import type { GradingKey } from "../src/key.ts";
import { CHOICE_LETTERS } from "../src/layout.ts";
import { debugImageName, summarizeStderr, type Skipped } from "../src/report.ts";
import {
    duplicateNames,
    parseReviewReply,
    reviewReply,
    type AnswerItem,
    type NameItem,
    type ResponseItem,
    type ReviewDecision,
    type ReviewItem,
    type ReviewThresholds,
    type Verdict,
} from "../src/review.ts";
import type { JobEvent } from "./grader-api.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
}

const show = (e: HTMLElement, on = true) => e.classList.toggle("d-none", !on);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function download(name: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Input -----------------------------------------------------------------

type Input = { kind: "zip"; file: File } | { kind: "images"; files: File[] };
let input: Input | null = null;

const IMAGE = /\.(jpe?g|png)$/i;
const byName = (a: File, b: File) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
/** The chosen test JSON, once it validates with an answer for every question. */
let test: { file: File; key: GradingKey } | null = null;
const optMark = $<HTMLInputElement>("opt-mark");
const optBlank = $<HTMLInputElement>("opt-blank");
const optDebug = $<HTMLInputElement>("opt-debug");

function inputError(message: string | null): void {
    const box = $("input-error");
    box.replaceChildren();
    if (message) box.append(el("i", "bi bi-exclamation-octagon me-1"), message);
    show(box, !!message);
}

function addFiles(list: File[]): void {
    const zips = list.filter((f) => /\.zip$/i.test(f.name));
    const images = list.filter((f) => IMAGE.test(f.name));
    const ignored = list.length - zips.length - images.length;
    if (zips.length && images.length) return inputError("Choose either one .zip file or page images, not both.");
    if (zips.length > 1) return inputError("Choose one .zip file at a time.");
    if (!zips.length && !images.length) return inputError("Those aren't .zip, PNG or JPG files.");
    if (zips.length) input = { kind: "zip", file: zips[0]! };
    else {
        // Add to the images already chosen; a file picked twice (same name and size) counts once.
        const have = input?.kind === "images" ? input.files : [];
        const seen = new Set(have.map((f) => `${f.name}\0${f.size}`));
        const added = images.filter((f) => !seen.has(`${f.name}\0${f.size}`));
        input = { kind: "images", files: [...have, ...added].sort(byName) };
    }
    inputError(ignored ? `Ignored ${plural(ignored, "file")} that ${ignored === 1 ? "isn't" : "aren't"} PNG or JPG.` : null);
    renderInput();
}

function renderInput(): void {
    const list = $<HTMLOListElement>("file-list");
    const files = !input ? [] : input.kind === "zip" ? [input.file] : input.files;
    list.replaceChildren(
        ...files.map((f) => {
            const li = el("li", "list-group-item d-flex gap-2 align-items-center");
            li.append(el("i", `bi ${input!.kind === "zip" ? "bi-file-earmark-zip" : "bi-file-earmark-image"} text-body-secondary`));
            li.append(el("span", "text-truncate me-auto", f.name), el("span", "text-body-secondary text-nowrap", kb(f.size)));
            return li;
        }),
    );
    show(list, files.length > 0);
    show($("file-empty"), !files.length);
    const total = files.reduce((n, f) => n + f.size, 0);
    $("file-summary").textContent = !input
        ? "Pages are graded in order: zip entries as stored, images by file name. Keep each student's pages together, page 1 first."
        : input.kind === "zip"
          ? `Zip of ${kb(total)}. Its pages are graded in the order they're stored.`
          : `${plural(files.length, "image")} (${kb(total)}), graded in this order. Keep each student's pages together, page 1 first.`;
    updateCommand();
}

function uploadName(): string {
    return input?.kind === "zip" ? input.file.name : "sheets.zip";
}

/** Reads and checks a test JSON; only one with an answer for every question can grade. */
async function chooseTest(f: File): Promise<void> {
    test = null;
    const errors = $("test-errors");
    const fail = (lines: string[]) => {
        errors.replaceChildren(...lines.map((l) => el("li", "", l)));
        show(errors, true);
        $("test-summary").textContent = "";
    };
    $("test-name").textContent = f.name;
    $("test-name").classList.remove("text-body-secondary");
    show(errors, false);
    if (f.size > 8 * 1024 * 1024) fail(["That file is too large to be a test."]);
    else {
        const parsed = parseSheetJson(await f.text(), { layout: false });
        if (!parsed.ok) fail([...parsed.errors.slice(0, 6).map((e) => `${e.where}: ${e.message}`), ...(parsed.errors.length > 6 ? [`…and ${parsed.errors.length - 6} more`] : [])]);
        else if (!parsed.grading) fail([`This test has no answers. Give every question an "answer" in the Sheet Generator, then save its JSON again.`]);
        else {
            test = { file: f, key: parsed.grading };
            const free = parsed.grading.filter((k) => k.type === "free").length;
            const points = parsed.grading.reduce((n, k) => n + k.points, 0);
            $("test-summary").textContent = [
                `“${parsed.test.title}”`,
                plural(parsed.grading.length, "question"),
                free && `${free} free response`,
                `${plural(points, "point")} in all`,
            ]
                .filter(Boolean)
                .join(" · ");
        }
    }
    updateCommand();
}

/** The chosen CLI options, as typed (the CLI validates them; grade() pre-checks the range). */
function cliOptions(): { mark: string; blank: string; debug: boolean } {
    const mark = optMark.value.trim();
    const blank = optBlank.value.trim();
    return { mark, blank, debug: optDebug.checked };
}

function updateCommand(): void {
    const o = cliOptions();
    const name = uploadName();
    const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
    const parts = ["bun run grade.ts", q(name), "--test", q(test?.file.name ?? "test.json")];
    if (o.mark) parts.push("--mark", o.mark);
    if (o.blank) parts.push("--blank", o.blank);
    if (o.debug) parts.push("--debug");
    parts.push("--review");
    $("command-preview").textContent = parts.join(" ");
    $<HTMLButtonElement>("btn-grade").disabled = !input || !test || running;
}

async function zipBytes(): Promise<Uint8Array> {
    if (input!.kind === "zip") return new Uint8Array(await input!.file.arrayBuffer());
    // Images are already compressed: store them. Names end in an extension, so fflate keeps
    // insertion (file-name) order.
    const files: Record<string, [Uint8Array, { level: 0 }]> = {};
    for (const f of input!.files) files[f.name] = [new Uint8Array(await f.arrayBuffer()), { level: 0 }];
    return zipSync(files);
}

// ---- Running the CLI -------------------------------------------------------

let running = false;
let jobId: string | null = null;
let source: EventSource | null = null;
let log: string[] = [];

const runStatus = $("run-status");
const progressBar = $("progress-bar");
const cliLog = $("cli-log");

function status(text: string, state: "busy" | "ok" | "warn" | "error" | "idle" = "busy"): void {
    runStatus.textContent = text;
    show($("run-spinner"), state === "busy");
    const icon = $("run-icon");
    const icons = { ok: "bi-check-circle-fill text-success", warn: "bi-exclamation-triangle-fill text-warning", error: "bi-x-octagon-fill text-danger", idle: "bi-stop-circle text-body-secondary" };
    show(icon, state !== "busy");
    if (state !== "busy") icon.className = `bi ${icons[state]}`;
}

function progress(fraction: number, striped: boolean): void {
    progressBar.style.width = `${Math.round(fraction * 100)}%`;
    progressBar.classList.toggle("progress-bar-striped", striped);
    progressBar.classList.toggle("progress-bar-animated", striped);
}

function appendLog(text: string): void {
    cliLog.textContent += `${text}\n`;
    cliLog.scrollTop = cliLog.scrollHeight;
}

function setRunning(on: boolean): void {
    running = on;
    show($("btn-cancel"), on);
    for (const id of ["btn-zip", "btn-images", "btn-clear-files", "btn-test-file"]) $<HTMLButtonElement>(id).disabled = on;
    updateCommand();
}

function resetResults(): void {
    for (const id of ["result-alert", "results-card", "skipped-card", "images-card", "review-card"]) show($(id), false);
    review = null;
    cliLog.textContent = "";
    $("run-command").textContent = "";
    log = [];
}

/** Uploads the zip and the test JSON as one form. */
function upload(bytes: Uint8Array, testFile: File, params: URLSearchParams): Promise<string> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `/api/grader/jobs?${params}`);
        const form = new FormData();
        form.append("zip", new Blob([bytes as BlobPart], { type: "application/zip" }), uploadName());
        form.append("test", testFile, testFile.name);
        xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            status(`Uploading ${kb(e.loaded)} of ${kb(e.total)}…`);
            progress(e.loaded / e.total, false);
        };
        xhr.onload = () => {
            let body: { id?: string; error?: string } = {};
            try {
                body = JSON.parse(xhr.responseText);
            } catch {}
            if (xhr.status === 201 && body.id) resolve(body.id);
            else reject(new Error(body.error ?? `upload failed (HTTP ${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error("couldn't reach the grader server. Is `bun run web` still running?"));
        xhr.send(form);
    });
}

async function grade(): Promise<void> {
    if (!input || !test || running) return;
    const testFile = test.file;
    inputError(null);
    const o = cliOptions();
    for (const [flag, v] of [["Mark", o.mark], ["Blank", o.blank]] as const) {
        if (v && !(Number(v) >= 0 && Number(v) <= 1)) return inputError(`${flag} threshold must be a number between 0 and 1.`);
    }
    resetResults();
    show($("empty-state"), false);
    show($("run"));
    setRunning(true);
    status(input.kind === "images" ? "Zipping images…" : "Reading the zip…");
    progress(0, true);
    try {
        const bytes = await zipBytes();
        const params = new URLSearchParams({ name: uploadName() });
        if (o.mark) params.set("mark", o.mark);
        if (o.blank) params.set("blank", o.blank);
        if (o.debug) params.set("debug", "1");
        params.set("review", "1");
        jobId = await upload(bytes, testFile, params);
    } catch (e) {
        setRunning(false);
        status(`Couldn't start grading: ${(e as Error).message}`, "error");
        progress(0, false);
        return;
    }
    status("Starting the grader…");
    progress(0, true);
    source = new EventSource(`/api/grader/jobs/${jobId}/events`);
    source.onmessage = (m) => onEvent(JSON.parse(m.data) as JobEvent);
}

/**
 * Answers the prompt `at` ("key" or a review item) that the CLI is waiting at. The first request
 * after a pause sometimes stalls over a remote link (e.g. Tailscale), so a slow one is abandoned
 * and retried. The server only accepts a reply for the prompt that is waiting, so a stalled
 * request arriving late can't answer a later prompt, and a 409 on a retry means it got through.
 */
async function sendReply(at: string, line: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 10_000);
        const res = await fetch(`/api/grader/jobs/${jobId}/input?at=${encodeURIComponent(at)}`, { method: "POST", body: line, signal: ctl.signal }).catch(() => null);
        clearTimeout(timer);
        if (res?.ok || (res?.status === 409 && attempt > 0)) return true;
        if (res) return false;
    }
    return false;
}

function onEvent(e: JobEvent): void {
    switch (e.type) {
        case "start":
            $("run-command").textContent = `$ ${e.command}`;
            return;
        case "log": {
            appendLog(e.text);
            log.push(e.text);
            const s = summarizeStderr(log);
            if (s.pages && s.decoded < s.pages) {
                status(`Reading pages: ${s.decoded} of ${s.pages}`);
                progress(s.decoded / s.pages, false);
            } else if (s.pages && s.decoded === s.pages) {
                status("Reading names and written answers…");
                progress(1, true);
            }
            return;
        }
        case "prompt":
            // The key comes from the test JSON, so the CLI never asks for one; stop if it does.
            appendLog(`Answer key for ${e.questions} questions: …`);
            status("The grader asked for an answer key it should have read from the test", "error");
            cancel();
            return;
        case "keyError":
        case "keyAccepted":
            return;
        case "review":
            startReview(e.thresholds, e.items);
            return;
        case "reviewPrompt":
            onReviewPrompt(e.item);
            return;
        case "reviewError":
            appendLog(`  ${e.text}`);
            onReviewError(e.item, e.text);
            return;
        case "done":
            source?.close();
            source = null;
            setRunning(false);
            show($("review-card"), false);
            progress(1, false);
            showResults(e);
            return;
    }
}

function cancel(): void {
    if (!jobId || !running) return;
    void fetch(`/api/grader/jobs/${jobId}/cancel`, { method: "POST" });
}

// ---- Review ----------------------------------------------------------------
// The CLI asks about each item in turn; the page shows them all as one form, and once the user
// finishes it, answers each prompt as it arrives.

interface SubmissionReview {
    name: NameItem;
    answers: AnswerItem[];
    /** Written answers, each with the points box the user can change. */
    responses: { item: ResponseItem; input: HTMLInputElement }[];
    skip: boolean;
    nameInput: HTMLInputElement;
    dupNote: HTMLElement;
    li: HTMLElement;
}

let review: {
    thresholds: ReviewThresholds;
    subs: SubmissionReview[];
    total: number;
    /** Chosen choices per answer item id; starts as what the grader read. */
    chosen: Map<number, Set<number>>;
    /** Replies per item id, set when the user finishes the form. */
    replies: Map<number, string> | null;
    /** The item whose prompt the CLI is waiting at. */
    waiting: number | null;
} | null = null;

const reviewList = $("review-list");
const reviewError = $("review-error");
const reviewImageUrl = (name: string) => `/api/grader/jobs/${jobId}/review/${encodeURIComponent(name)}`;

function startReview(thresholds: ReviewThresholds, items: ReviewItem[]): void {
    const subs: SubmissionReview[] = [];
    const chosen = new Map<number, Set<number>>();
    for (const item of items) {
        // Each submission's name item comes before its other items. renderSubmission fills in
        // the elements.
        if (item.kind === "name") subs[item.submission] = { name: item, answers: [], responses: [], skip: false } as unknown as SubmissionReview;
        else if (item.kind === "response") subs[item.submission]!.responses.push({ item, input: null as unknown as HTMLInputElement });
        else {
            subs[item.submission]!.answers.push(item);
            chosen.set(item.id, new Set(item.marked));
        }
    }
    review = { thresholds, subs, total: items.length, chosen, replies: null, waiting: null };
    reviewList.replaceChildren(...subs.map(renderSubmission));
    const answers = items.filter((i) => i.kind === "answer").length;
    const written = items.filter((i) => i.kind === "response").length;
    $("review-counts").textContent = [plural(subs.length, "name"), answers && plural(answers, "unclear answer"), written && plural(written, "written answer")]
        .filter(Boolean)
        .join(" · ");
    reviewError.textContent = "";
    $<HTMLFieldSetElement>("review-fieldset").disabled = false;
    $<HTMLButtonElement>("btn-finish-review").disabled = false;
    updateReviewNotes();
    show($("review-card"));
    progress(1, false);
    status("Waiting for your review", "busy");
    show($("run-spinner"), false);
    const firstEmpty = subs.find((s) => s.name.ocr === null)?.nameInput ?? subs.flatMap((s) => s.responses).find((r) => r.item.points === null)?.input;
    (firstEmpty ?? $("btn-finish-review")).focus({ preventScroll: true });
    $("review-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderSubmission(sub: SubmissionReview): HTMLElement {
    const li = el("li", "list-group-item py-3");
    sub.li = li;
    const head = el("div", "d-flex align-items-center gap-2 mb-2");
    head.append(el("span", "small font-monospace text-body-secondary text-truncate me-auto", sub.name.files.join(", ")));
    const skip = el("button", "btn btn-sm btn-outline-secondary text-nowrap");
    skip.type = "button";
    const label = () => {
        skip.replaceChildren(el("i", `bi ${sub.skip ? "bi-arrow-counterclockwise" : "bi-slash-circle"} me-1`), sub.skip ? "Include" : "Skip");
        skip.title = sub.skip ? "Grade this submission" : "Leave this submission out of the grades";
        skip.ariaPressed = String(sub.skip);
    };
    label();
    skip.addEventListener("click", () => {
        sub.skip = !sub.skip;
        li.classList.toggle("review-skipped", sub.skip);
        label();
        updateReviewNotes();
    });
    head.append(skip);

    const body = el("div", "review-body");
    const row = el("div", "row g-2 align-items-center");
    const imgCol = el("div", "col-sm-6");
    const img = el("img", "review-name-crop border rounded");
    img.src = reviewImageUrl(sub.name.image);
    img.alt = `Name box on ${sub.name.files[0]}`;
    img.addEventListener("error", () => img.replaceWith(el("span", "small text-body-secondary", "No image of the name box")));
    imgCol.append(img);
    const inputCol = el("div", "col-sm-6");
    const input = el("input", "form-control");
    input.type = "text";
    input.value = sub.name.ocr ?? "";
    input.placeholder = "Type the student's name";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.ariaLabel = `Student name for ${sub.name.files[0]}`;
    input.addEventListener("input", () => {
        input.classList.remove("is-invalid");
        updateReviewNotes();
    });
    sub.nameInput = input;
    const ocrNote =
        sub.name.ocr === null
            ? el("div", "form-text text-danger", `Couldn't read the name: ${sub.name.error ?? "unknown error"}`)
            : el("div", "form-text", "Read from the sheet; correct it if it's wrong.");
    sub.dupNote = el("div", "form-text text-warning-emphasis d-none");
    inputCol.append(input, ocrNote, sub.dupNote);
    row.append(imgCol, inputCol);
    body.append(row);
    // Unclear answers and written answers, in question order.
    const parts = [
        ...sub.answers.map((item) => ({ question: item.question, render: () => renderAnswer(item) })),
        ...sub.responses.map((r) => ({ question: r.item.question, render: () => renderResponse(r) })),
    ].sort((a, b) => a.question - b.question);
    for (const p of parts) body.append(p.render());
    li.append(head, body);
    return li;
}

function renderResponse(r: SubmissionReview["responses"][number]): HTMLElement {
    const { item } = r;
    const box = el("div", "review-answer");
    box.dataset.item = String(item.id);
    const title = el("div", "small mb-1");
    title.append(el("span", "fw-semibold", `Question ${item.question}`), el("span", "text-body-secondary", ` · written answer · ${item.file}`));

    const img = el("img", "review-response-crop border rounded");
    img.src = reviewImageUrl(item.image);
    img.alt = `Written answer to question ${item.question} on ${item.file}`;
    img.addEventListener("error", () => img.replaceWith(el("span", "small text-body-secondary", "No image of the answer box")));

    const row = el("div", "row g-2 align-items-start mt-1");
    const textCol = el("div", "col-sm-9 small");
    if (item.text === null) textCol.append(el("div", "text-danger", `Couldn't read the answer: ${item.error ?? "unknown error"}`));
    else {
        const read = el("div", "review-transcript");
        read.append(el("span", "text-body-secondary", "Read as: "), item.text ? el("q", "", item.text) : el("em", "text-body-secondary", "(blank)"));
        textCol.append(read);
        if (!item.legible) textCol.append(el("div", "text-warning-emphasis", "Some of the writing couldn't be read; check it against the image."));
        if (item.points !== null && item.feedback) textCol.append(el("div", "text-body-secondary mt-1", item.feedback));
        if (item.points === null && item.error) textCol.append(el("div", "text-danger mt-1", `Not graded: ${item.error}`));
    }
    const pointsCol = el("div", "col-sm-3");
    const group = el("div", "input-group input-group-sm");
    const input = el("input", "form-control text-end font-monospace");
    input.type = "number";
    input.min = "0";
    input.max = String(item.maxPoints);
    input.step = "1";
    input.value = item.points === null ? "" : String(item.points);
    input.placeholder = "?";
    input.ariaLabel = `Points for question ${item.question} on ${item.file}`;
    input.addEventListener("input", () => input.classList.remove("is-invalid"));
    r.input = input;
    group.append(input, el("span", "input-group-text", `/ ${item.maxPoints}`));
    pointsCol.append(group, el("div", "form-text", item.points === null ? "Give the points" : "Points awarded"));
    row.append(textCol, pointsCol);
    box.append(title, img, row);
    return box;
}

function renderAnswer(item: AnswerItem): HTMLElement {
    const box = el("div", "review-answer");
    box.dataset.item = String(item.id);
    const title = el("div", "small mb-1");
    title.append(el("span", "fw-semibold", `Question ${item.question}`), el("span", "text-body-secondary", ` · ${item.file}`));

    const pic = el("div", "review-question border rounded overflow-hidden");
    const img = el("img");
    img.src = reviewImageUrl(item.image);
    img.alt = `Question ${item.question} on ${item.file}`;
    img.width = item.width;
    img.height = item.height;
    img.style.height = "auto";
    pic.append(img);

    const choices = el("div", "d-flex flex-wrap align-items-center gap-2 mt-2");
    choices.role = "group";
    choices.ariaLabel = `Answer to question ${item.question}`;
    const none = el("span", "badge rounded-pill text-bg-warning", "Response Omitted");
    const { mark, blank } = review!.thresholds;
    const zone: Record<Verdict, string> = { marked: "reads as filled", ambiguous: "unclear", blank: "reads as empty" };
    const scale = `filled above ${Math.round(mark * 100)}%, empty below ${Math.round(blank * 100)}%`;
    const chosen = review!.chosen.get(item.id)!;
    const ringButtons: HTMLButtonElement[] = [];
    const boxes: HTMLInputElement[] = [];
    const refresh = () => {
        for (let c = 0; c < item.choices; c++) {
            const on = chosen.has(c);
            ringButtons[c]!.classList.toggle("chosen", on);
            ringButtons[c]!.ariaPressed = String(on);
            boxes[c]!.checked = on;
        }
        show(none, chosen.size === 0);
    };
    const toggle = (c: number) => {
        if (!chosen.delete(c)) chosen.add(c);
        refresh();
    };
    const pct = (v: number, of: number) => `${(v / of) * 100}%`;
    item.rings.forEach((ring, c) => {
        const letter = CHOICE_LETTERS[c]!;
        const unclear = item.unclear.includes(c);
        const verdict = item.verdicts[c]!;
        const dark = `${Math.round(item.fills[c]! * 100)}%`;
        const hint = `${dark} dark, ${zone[verdict]} (${scale})`;
        const b = el("button", `review-ring${unclear ? " unclear" : ""}`);
        b.type = "button";
        b.title = `${letter}: ${hint}`;
        b.ariaLabel = `Choice ${letter}`;
        Object.assign(b.style, {
            left: pct(ring.x - ring.r, item.width),
            top: pct(ring.y - ring.r, item.height),
            width: pct(2 * ring.r, item.width),
            height: pct(2 * ring.r, item.height),
        });
        b.addEventListener("click", () => toggle(c));
        const tag = el("span", "review-ring-label", letter);
        tag.style.left = pct(ring.x - ring.r - 3, item.width);
        tag.style.top = pct(ring.y, item.height);
        pic.append(b, tag);
        ringButtons.push(b);

        const chip = el("label", "review-chip");
        chip.title = hint;
        const check = el("input", "form-check-input m-0");
        check.type = "checkbox";
        check.ariaLabel = `${letter}, ${dark} dark, ${zone[verdict]}`;
        check.addEventListener("change", () => toggle(c));
        const bar = el("span", "review-chip-bar");
        bar.ariaHidden = "true";
        const level = el("span", verdict);
        level.style.width = `${Math.min(100, Math.max(0, item.fills[c]! * 100))}%`;
        bar.append(level);
        const main = el("span", "review-chip-main");
        main.append(el("span", "review-chip-letter", letter), el("span", "review-chip-fill", dark), bar);
        chip.append(check, main);
        choices.append(chip);
        boxes.push(check);
    });
    choices.append(none);
    refresh();
    box.append(title, pic, choices);
    return box;
}

/** Duplicate-name warnings and the skipped count. */
function updateReviewNotes(): void {
    if (!review) return;
    const active = review.subs.filter((s) => !s.skip);
    const dups = duplicateNames(active.map((s) => ({ name: s.nameInput.value, file: s.name.files[0]! })));
    for (const s of review.subs) {
        const files = s.skip ? undefined : dups.get(s.nameInput.value.trim().toLowerCase());
        const others = files?.filter((f) => f !== s.name.files[0]) ?? [];
        s.dupNote.textContent = others.length ? `Same name as the submission on ${others.join(", ")}` : "";
        show(s.dupNote, others.length > 0);
    }
    const skipped = review.subs.length - active.length;
    $("review-summary").textContent = skipped ? `${plural(skipped, "submission")} will be skipped` : "";
}

/** Checks the form and works out the reply to every item; null (with errors shown) if incomplete. */
function reviewReplies(): Map<number, string> | null {
    const replies = new Map<number, string>();
    let firstBad: HTMLElement | null = null;
    for (const s of review!.subs) {
        const decisions: [ReviewItem, ReviewDecision | string, HTMLElement][] = s.skip
            ? [[s.name, { skip: true }, s.nameInput]]
            : [
                  [s.name, { name: s.nameInput.value }, s.nameInput],
                  ...s.answers.map((a): [ReviewItem, ReviewDecision, HTMLElement] => [a, { answer: [...review!.chosen.get(a.id)!].sort((x, y) => x - y) }, s.li]),
                  // The points box's text is the reply; the CLI checks it like a typed one.
                  ...s.responses.map((r): [ReviewItem, string, HTMLElement] => [r.item, r.input.value.trim(), r.input]),
              ];
        for (const [item, d, field] of decisions) {
            const reply = typeof d === "string" ? d : reviewReply(d);
            // An empty reply keeps the OCR'd name (or the awarded points) at the CLI's prompt; here an empty box is an error.
            const empty = typeof d === "string" ? !d : "name" in d && !d.name.trim();
            if (empty || "error" in parseReviewReply(item, reply)) {
                if (item.kind !== "answer") field.classList.add("is-invalid");
                firstBad ??= field;
                continue;
            }
            replies.set(item.id, reply);
        }
    }
    if (firstBad) {
        reviewError.textContent = "Every submission needs a name and points for each written answer (a whole number up to its points), or skip it.";
        firstBad.focus();
        return null;
    }
    return replies;
}

function finishReview(): void {
    if (!review || review.replies) return;
    reviewError.textContent = "";
    const replies = reviewReplies();
    if (!replies) return;
    review.replies = replies;
    $<HTMLFieldSetElement>("review-fieldset").disabled = true;
    $<HTMLButtonElement>("btn-finish-review").disabled = true;
    status("Grading…");
    progress(1, true);
    if (review.waiting !== null) void answerReview(review.waiting);
}

function onReviewPrompt(item: number): void {
    if (!review) return;
    review.waiting = item;
    if (review.replies) void answerReview(item);
}

async function answerReview(item: number): Promise<void> {
    const reply = review?.replies?.get(item);
    if (reply === undefined) return;
    review!.waiting = null;
    appendLog(`Review ${item}/${review!.total}: ${reply || "(keep)"}`);
    if (!(await sendReply(String(item), reply))) {
        status("Couldn't send the review", "error");
        unlockReview();
    }
}

function onReviewError(item: number, text: string): void {
    unlockReview();
    const where = review?.subs.find((s) => s.name.id === item || s.answers.some((a) => a.id === item) || s.responses.some((r) => r.item.id === item));
    reviewError.textContent = `The grader rejected this: ${text}`;
    where?.li.scrollIntoView({ behavior: "smooth", block: "center" });
}

function unlockReview(): void {
    if (!review) return;
    review.replies = null;
    $<HTMLFieldSetElement>("review-fieldset").disabled = false;
    $<HTMLButtonElement>("btn-finish-review").disabled = false;
    status("Waiting for your review", "busy");
    show($("run-spinner"), false);
}

// ---- Results ---------------------------------------------------------------

let csvText = "";

function badge(icon: string, text: string): HTMLElement {
    const b = el("span", "badge rounded-pill text-bg-light border");
    b.append(el("i", `bi ${icon} me-1`), text);
    return b;
}

function alertBox(kind: string, icon: string, title: string, detail?: string): void {
    const box = $("result-alert");
    box.className = `alert alert-${kind}`;
    box.replaceChildren(el("i", `bi ${icon} me-1`), el("strong", "", title));
    if (detail) box.append(el("div", "small mt-1", detail));
}

function showResults(e: Extract<JobEvent, { type: "done" }>): void {
    const s = summarizeStderr(log);
    csvText = e.csv;
    if (e.cancelled) {
        status("Cancelled", "idle");
        alertBox("secondary", "bi-stop-circle", "Grading was cancelled.");
    } else if (e.exitCode === 0) {
        status("Done", "ok");
        alertBox("success", "bi-check-circle", "Every submission was graded.", s.totals);
    } else if (e.exitCode === 2) {
        status("Done, with skipped submissions", "warn");
        alertBox("warning", "bi-exclamation-triangle", "Some submissions were skipped. Fix or rescan them, then grade those again.", s.totals);
    } else {
        status("The grader stopped", "error");
        alertBox("danger", "bi-x-octagon", s.fatal ? `The grader stopped: ${s.fatal}` : `The grader exited with code ${e.exitCode}.`);
    }

    renderTable(e.csv);
    renderSkipped(s.skipped, e.images);
    renderImages(e.images);
}

interface Row {
    name: string;
    score: number;
    total: number;
    percent: number;
    percentText: string;
    /** Per free-response question, in column order: points, transcript and the grading reason. */
    free: { points: string; text: string; feedback: string }[];
}
let rows: Row[] = [];
/** The free-response questions' numbers (1-based), in column order. */
let freeQuestions: number[] = [];
let sort: { key: Exclude<keyof Row, "free">; dir: 1 | -1 } = { key: "name", dir: 1 };

function renderTable(csv: string): void {
    let parsed: string[][];
    try {
        parsed = parseCsv(csv);
    } catch (err) {
        if (csv) alertBox("danger", "bi-x-octagon", `The CLI's CSV couldn't be read: ${(err as Error).message}`);
        return;
    }
    const [header, ...body] = parsed;
    if (!header) return;
    // The summary columns, then three per free-response question.
    const extra = header.slice(CSV_HEADER.length);
    freeQuestions = [];
    for (let i = 0; i + 2 < extra.length; i += 3) {
        const m = FREE_COLUMN_RE.exec(extra[i]!);
        if (m && m[2] === "points") freeQuestions.push(Number(m[1]));
    }
    if (header.slice(0, CSV_HEADER.length).join() !== CSV_HEADER.join() || extra.length !== 3 * freeQuestions.length) {
        alertBox("danger", "bi-x-octagon", `Unexpected CSV header: ${header.join(",")}`);
        return;
    }
    rows = body.map(([name = "", score = "", total = "", percent = "", ...rest]) => ({
        name,
        score: Number(score),
        total: Number(total),
        percent: Number(percent),
        percentText: percent,
        free: freeQuestions.map((_, k) => ({ points: rest[3 * k] ?? "", text: rest[3 * k + 1] ?? "", feedback: rest[3 * k + 2] ?? "" })),
    }));
    show($("results-card"));
    const pct = rows.map((r) => r.percent);
    const avg = pct.length ? pct.reduce((a, b) => a + b, 0) / pct.length : 0;
    $("result-badges").replaceChildren(
        badge("bi-people", `${plural(rows.length, "student")} graded`),
        ...(rows.length
            ? [badge("bi-bar-chart", `Average ${avg.toFixed(1)}%`), badge("bi-arrows-expand", `Range ${Math.min(...pct).toFixed(1)}–${Math.max(...pct).toFixed(1)}%`)]
            : []),
        badge("bi-list-ol", rows[0] ? `Out of ${plural(rows[0].total, "point")}` : "No rows"),
    );
    renderRows();
}

const COLUMNS: { key: Exclude<keyof Row, "free">; label: string; numeric: boolean }[] = [
    { key: "name", label: "Student", numeric: false },
    { key: "score", label: "Score", numeric: true },
    { key: "total", label: "Total", numeric: true },
    { key: "percent", label: "Percent", numeric: true },
];

function renderRows(): void {
    const table = $<HTMLTableElement>("grades-table");
    const tr = el("tr");
    for (const c of COLUMNS) {
        const th = el("th", c.numeric ? "text-end" : "");
        th.scope = "col";
        const btn = el("button", "btn btn-link btn-sm p-0 fw-semibold text-body text-decoration-none", c.label);
        btn.type = "button";
        if (sort.key === c.key) btn.append(el("i", `bi ${sort.dir === 1 ? "bi-caret-up-fill" : "bi-caret-down-fill"} ms-1 small`));
        btn.addEventListener("click", () => {
            sort = { key: c.key, dir: sort.key === c.key ? (-sort.dir as 1 | -1) : c.numeric ? -1 : 1 };
            renderRows();
        });
        th.append(btn);
        th.ariaSort = sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none";
        tr.append(th);
    }
    for (const n of freeQuestions) {
        const th = el("th", "text-end text-nowrap", `Q${n}`);
        th.scope = "col";
        th.title = `Free-response question ${n}: points awarded (open a cell for the answer as read and the grading reason)`;
        tr.append(th);
    }
    table.tHead!.replaceChildren(tr);

    const sorted = [...rows].sort((a, b) => {
        const x = a[sort.key];
        const y = b[sort.key];
        const c = typeof x === "number" ? x - (y as number) : String(x).localeCompare(String(y), undefined, { sensitivity: "base" });
        return c * sort.dir || a.name.localeCompare(b.name);
    });
    table.tBodies[0]!.replaceChildren(
        ...sorted.map((r) => {
            const row = el("tr");
            row.append(el("td", "", r.name), el("td", "text-end font-monospace", String(r.score)), el("td", "text-end font-monospace", String(r.total)));
            const pct = el("td", "text-end");
            const bar = el("div", "d-flex align-items-center justify-content-end gap-2");
            const meter = el("div", "progress grade-meter d-none d-sm-flex");
            const fill = el("div", `progress-bar ${r.percent >= 70 ? "bg-success" : r.percent >= 50 ? "bg-warning" : "bg-danger"}`);
            fill.style.width = `${r.percent}%`;
            meter.append(fill);
            bar.append(meter, el("span", "font-monospace", `${r.percentText}%`));
            pct.append(bar);
            row.append(pct);
            r.free.forEach((x, k) => {
                const td = el("td", "text-end free-cell");
                const details = el("details");
                details.append(el("summary", "font-monospace", x.points || "–"));
                const more = el("div", "free-detail text-start small");
                more.append(el("div", "", x.text ? `“${x.text}”` : "(blank)"));
                if (x.feedback) more.append(el("div", "text-body-secondary mt-1", x.feedback));
                details.append(more);
                details.title = `Question ${freeQuestions[k]}`;
                td.append(details);
                row.append(td);
            });
            return row;
        }),
    );
}

const imageUrl = (name: string) => `/api/grader/jobs/${jobId}/images/${encodeURIComponent(name)}`;

function renderSkipped(skipped: Skipped[], images: string[]): void {
    show($("skipped-card"), skipped.length > 0);
    if (!skipped.length) return;
    const subs = skipped.filter((s) => !s.orphan).length;
    const orphans = skipped.length - subs;
    $("skipped-title").textContent = [subs && `${plural(subs, "submission")} skipped`, orphans && `${plural(orphans, "group")} of orphan pages`].filter(Boolean).join(", ");
    const have = new Set(images);
    $("skipped-list").replaceChildren(
        ...skipped.map((s) => {
            const li = el("li", "list-group-item");
            const head = el("div", "d-flex flex-wrap gap-1 align-items-center mb-1");
            head.append(el("span", `badge ${s.orphan ? "text-bg-secondary" : "text-bg-warning"} me-1`, s.orphan ? "Orphan pages" : "Submission"));
            for (const f of s.files) {
                const img = debugImageName(f);
                if (have.has(img)) {
                    const a = el("a", "small font-monospace me-2", f);
                    a.href = imageUrl(img);
                    a.target = "_blank";
                    a.rel = "noopener";
                    a.title = "Open the diagnostic image";
                    head.append(a);
                } else head.append(el("span", "small font-monospace me-2", f));
            }
            const ul = el("ul", "small mb-0 ps-3");
            ul.append(...s.reasons.map((r) => el("li", "", r)));
            li.append(head, ul);
            return li;
        }),
    );
}

function renderImages(images: string[]): void {
    show($("images-card"), images.length > 0);
    if (!images.length) return;
    $<HTMLAnchorElement>("images-zip").href = `/api/grader/jobs/${jobId}/images.zip`;
    $("images-grid").replaceChildren(
        ...images.map((name) => {
            const col = el("div", "col");
            const a = el("a", "d-block text-decoration-none diag-thumb");
            a.href = imageUrl(name);
            a.target = "_blank";
            a.rel = "noopener";
            const img = el("img", "img-fluid border rounded");
            img.src = imageUrl(name);
            img.alt = `Diagnostic image for ${name}`;
            img.loading = "lazy";
            a.append(img, el("div", "small text-body-secondary text-truncate mt-1", name));
            col.append(a);
            return col;
        }),
    );
}

async function copyCsv(): Promise<void> {
    await navigator.clipboard.writeText(csvText).catch(() => {});
    const icon = $("copy-csv-icon");
    icon.className = "bi bi-clipboard-check";
    setTimeout(() => (icon.className = "bi bi-clipboard"), 1500);
}

// ---- Wiring ----------------------------------------------------------------

const zipInput = $<HTMLInputElement>("zip-input");
const imagesInput = $<HTMLInputElement>("images-input");
const testFile = $<HTMLInputElement>("test-file");

$("btn-zip").addEventListener("click", () => zipInput.click());
$("btn-images").addEventListener("click", () => imagesInput.click());
for (const fi of [zipInput, imagesInput]) {
    fi.addEventListener("change", () => {
        if (fi.files?.length) addFiles([...fi.files]);
        fi.value = "";
    });
}
$("btn-clear-files").addEventListener("click", () => {
    input = null;
    inputError(null);
    renderInput();
});
$("btn-test-file").addEventListener("click", () => testFile.click());
testFile.addEventListener("change", () => {
    const f = testFile.files?.[0];
    testFile.value = "";
    if (f) void chooseTest(f);
});
for (const o of [optMark, optBlank, optDebug]) o.addEventListener("input", updateCommand);
$("btn-grade").addEventListener("click", () => void grade());
$("btn-cancel").addEventListener("click", cancel);
$("review-card").addEventListener("submit", (e) => {
    e.preventDefault();
    finishReview();
});
$("btn-copy-csv").addEventListener("click", () => void copyCsv());
$("btn-download-csv").addEventListener("click", () => {
    const base = uploadName().replace(/\.zip$/i, "");
    download(`${base}-grades.csv`, new Blob([csvText], { type: "text/csv" }));
});

const dropZone = $("drop-zone");
let dragDepth = 0;
dropZone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (running) return;
    dragDepth++;
    dropZone.classList.add("dragging");
});
dropZone.addEventListener("dragover", (e) => e.preventDefault());
dropZone.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
        dragDepth = 0;
        dropZone.classList.remove("dragging");
    }
});
dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove("dragging");
    if (running || !e.dataTransfer?.files.length) return;
    // A .json dropped with the sheets is the test.
    const files = [...e.dataTransfer.files];
    const json = files.find((f) => /\.json$/i.test(f.name));
    if (json) void chooseTest(json);
    const rest = files.filter((f) => f !== json);
    if (rest.length) addFiles(rest);
});

window.addEventListener("beforeunload", (e) => {
    if (running) e.preventDefault();
});
window.addEventListener("pagehide", () => {
    if (running && jobId) navigator.sendBeacon(`/api/grader/jobs/${jobId}/cancel`);
});

// Server info: thresholds defaults and whether OCR is configured.
fetch("/api/grader/info")
    .then((r) => r.json() as Promise<{ missing: string[]; thresholds: { markThreshold: number; blankThreshold: number } }>)
    .then((info) => {
        optMark.placeholder = `${info.thresholds.markThreshold} (default)`;
        optBlank.placeholder = `${info.thresholds.blankThreshold} (default)`;
        if (info.missing.length) {
            $("config-missing").textContent = info.missing.join(" and ");
            show($("config-warning"));
        }
    })
    .catch(() => inputError("Couldn't reach the grader server. Start it with `bun run web`."));

renderInput();
