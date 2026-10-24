// Grader UI: a front end for the grading CLI. The sheets go to the local server as one zip
// (picked images are zipped here, in file-name order) with the test's JSON, the server runs
// `bun run grade.ts --test` on them (web/grader-api.ts) with --review and streams the CLI's
// stderr back. This page answers the CLI's review prompts (names, unclear marks and written
// answers' points) and renders its CSV as a table.
import { zipSync } from "fflate";
import { parseSheetJson } from "../gen/testdef.ts";
import { CSV_HEADER, FREE_COLUMN_RE, csvRow, parseCsv } from "../src/csv.ts";
import type { GradingKey } from "../src/key.ts";
import { CHOICE_LETTERS } from "../src/layout.ts";
import { REQUESTS_RE, debugImageName, summarizeStderr, type Skipped } from "../src/report.ts";
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
import { startPage } from "./common.ts";
import { pickMaterial } from "./library-dialogs.ts";

await startPage("grader");

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
    // Starting a run needs a plan that can grade; say so up front rather than after the upload.
fetch("/api/me")
    .then((r) => (r.ok ? (r.json() as Promise<{ user: { canGrade: boolean } }>) : null))
    .then((me) => {
        if (me && !me.user.canGrade) show($("plan-warning"));
    })
    .catch(() => {});

renderInput();
}

function renderInput(): void {
    const list = $<HTMLOListElement>("file-list");
    const files = !input ? [] : input.kind === "zip" ? [input.file] : input.files;
    list.replaceChildren(
        ...files.map((f) => {
            const li = el("li", "list-group-item d-flex gap-3 align-items-center");
            li.append(el("i", `bi ${input!.kind === "zip" ? "bi-file-earmark-zip" : "bi-file-earmark-image"} fg-secondary`));
            li.append(el("span", "text-truncate me-auto", f.name), el("span", "fg-secondary text-nowrap", kb(f.size)));
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
    $("sheets-summary").textContent = !input ? "" : input.kind === "zip" ? input.file.name : plural(files.length, "image");
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
    $("test-name").classList.remove("fg-secondary");
    show(errors, false);
    if (f.size > 8 * 1024 * 1024) fail(["That file is too large to be a test."]);
    else {
        const parsed = parseSheetJson(await f.text(), { layout: false });
        if (!parsed.ok) fail([...parsed.errors.slice(0, 6).map((e) => `${e.where}: ${e.message}`), ...(parsed.errors.length > 6 ? [`…and ${parsed.errors.length - 6} more`] : [])]);
        else if (parsed.studyGuide) fail(['This is a study guide; there\'s nothing to grade. Change its top-level "type" to "Quiz" or "Exam" to grade it.']);
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
    $<HTMLButtonElement>("btn-continue").disabled = !input;
    $("test-header-summary").textContent = test ? test.file.name : "";
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
    const icons = { ok: "bi-check-circle-fill fg-success", warn: "bi-exclamation-triangle-fill fg-warning", error: "bi-x-octagon-fill fg-danger", idle: "bi-stop-circle fg-secondary" };
    show(icon, state !== "busy");
    if (state !== "busy") icon.className = `bi ${icons[state]}`;
}

function progress(fraction: number, striped: boolean): void {
    progressBar.style.width = `${Math.round(fraction * 100)}%`;
    progressBar.classList.toggle("progress-bar-striped", striped);
    progressBar.classList.toggle("progress-bar-animated", striped);
}

/** The second bar: model requests (names, written answers, grading) finished of those expected. */
function requestProgress(fraction: number | null): void {
    show($("progress-requests"), fraction !== null);
    $("progress-requests-bar").style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}

function appendLog(text: string): void {
    cliLog.textContent += `${text}\n`;
    cliLog.scrollTop = cliLog.scrollHeight;
}

type Panel = "panel-sheets" | "panel-test" | "panel-review" | "panel-results";

/** Opens one accordion panel; the panels share a `name`, so the others close. */
function openPanel(id: Panel): void {
    const panel = $<HTMLDetailsElement>(id);
    panel.open = true;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** The Review panel's placeholder, shown until there's something to review. */
function setReviewPlaceholder(title: string, detail: string, visible = true): void {
    $("empty-title").textContent = title;
    $("empty-detail").textContent = detail;
    show($("empty-state"), visible);
}

function setRunning(on: boolean): void {
    running = on;
    show($("btn-cancel-run"), on);
    if (on) show($("btn-view-results"), false);
    for (const id of ["btn-zip", "btn-images", "btn-clear-files", "btn-test-file"]) $<HTMLButtonElement>(id).disabled = on;
    updateCommand();
}

function resetResults(): void {
    for (const id of ["result-alert", "results-card", "chart-card", "skipped-card", "images-card", "review-card", "btn-view-results"]) show($(id), false);
    show($("results-empty"));
    $("review-header-summary").textContent = "";
    $("results-header-summary").textContent = "";
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
    requestProgress(null);
    setReviewPlaceholder("Reading the sheets…", "The review opens here once every name and written answer is read.");
    openPanel("panel-review");
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
        setReviewPlaceholder("Nothing to review yet", "Add the scanned sheets and the test, then choose Grade.");
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
            // The request counts only drive the second bar; the CLI output keeps its per-call timing lines.
            if (!REQUESTS_RE.test(e.text)) appendLog(e.text);
            log.push(e.text);
            const s = summarizeStderr(log);
            if (s.requests) requestProgress(s.requestsDone / s.requests);
            if (s.pages && s.decoded < s.pages) {
                status(`Reading pages: ${s.decoded} of ${s.pages}`);
                progress(s.decoded / s.pages, false);
            } else if (s.pages && s.decoded === s.pages) {
                status(s.requests && s.requestsDone < s.requests ? `Reading names and answers: ${s.requestsDone} of ${s.requests} requests` : "Reading names and written answers…");
                progress(1, false);
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
            requestProgress(e.cancelled ? null : 1);
            show($("review-card"), false);
            setReviewPlaceholder("Nothing left to review", "Grading is finished; see the results.");
            progress(1, false);
            showResults(e);
            show($("btn-view-results"));
            openPanel("panel-results");
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
    /** The stat strip's badges, filled by `refreshStats`. */
    stats?: { correct: HTMLElement; omitted: HTMLElement; percent: HTMLElement; points: HTMLElement };
    /** Why this sheet needs a look, worked out when the review opens; empty for a clean sheet. */
    flags: string[];
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
        if (item.kind === "name") subs[item.submission] = { name: item, answers: [], responses: [], skip: false, flags: [] } as unknown as SubmissionReview;
        else if (item.kind === "response") subs[item.submission]!.responses.push({ item, input: null as unknown as HTMLInputElement });
        else {
            subs[item.submission]!.answers.push(item);
            chosen.set(item.id, new Set(item.marked));
        }
    }
    review = { thresholds, subs, total: items.length, chosen, replies: null, waiting: null };
    const dups = duplicateNames(subs.map((s) => ({ name: s.name.ocr ?? "", file: s.name.files[0]! })));
    for (const s of subs) s.flags = sheetFlags(s, dups);
    reviewList.replaceChildren(...subs.map((s, i) => renderSubmission(s, i, subs.length)));
    // Start on the sheets that need a look, or on everything when none do.
    const flagged = subs.filter((s) => s.flags.length).length;
    $("view-all-count").textContent = String(subs.length);
    $("view-flagged-count").textContent = String(flagged);
    $<HTMLInputElement>(flagged ? "view-flagged" : "view-all").checked = true;
    applyReviewView();
    const answers = items.filter((i) => i.kind === "answer").length;
    const written = items.filter((i) => i.kind === "response").length;
    $("review-counts").textContent = [plural(subs.length, "name"), answers && plural(answers, "unclear answer"), written && plural(written, "written answer")]
        .filter(Boolean)
        .join(" · ");
    reviewError.textContent = "";
    $<HTMLFieldSetElement>("review-fieldset").disabled = false;
    $<HTMLButtonElement>("btn-finish-review").disabled = false;
    updateReviewNotes();
    refreshStats();
    show($("review-card"));
    show($("empty-state"), false);
    $("review-header-summary").textContent = `${plural(subs.length, "sheet")}, ${flagged} to check`;
    openPanel("panel-review");
    progress(1, false);
    status("Waiting for your review", "busy");
    show($("run-spinner"), false);
    const firstEmpty = subs.find((s) => s.name.ocr === null)?.nameInput ?? subs.flatMap((s) => s.responses).find((r) => r.item.points === null)?.input;
    (firstEmpty ?? $("btn-finish-review")).focus({ preventScroll: true });
}

/** Why a sheet needs review: a name that wasn't read or is shared, unclear bubbles, or a written answer that's blank, unreadable or ungraded. */
function sheetFlags(sub: SubmissionReview, dups: Map<string, string[]>): string[] {
    const flags: string[] = [];
    if (sub.name.ocr === null) flags.push("Name not recognized");
    else if (dups.has(sub.name.ocr.trim().toLowerCase())) flags.push("Duplicate name");
    if (sub.answers.length) flags.push(`${plural(sub.answers.length, "unclear answer")}`);
    const written = sub.responses.map((r) => r.item);
    if (written.some((r) => r.text === null || r.points === null)) flags.push("Grading error");
    if (written.some((r) => r.text === "")) flags.push("Blank written answer");
    if (written.some((r) => r.text && !r.legible)) flags.push("Illegible writing");
    return flags;
}

interface Outcome {
    /** 1-based question number. */
    question: number;
    correct: boolean;
    omitted: boolean;
    /** Points as it stands, or null for a written answer that has none yet. */
    points: number | null;
}

/**
 * Each question on a sheet as it stands in the form: multiple choice by the bubbles as chosen
 * (an exact match with the key is correct, like the grader's scoring; none chosen is omitted),
 * written answers by the points typed (full points is correct; a blank box is omitted).
 */
function sheetOutcomes(sub: SubmissionReview): Outcome[] {
    const stats = sub.name.stats;
    if (!stats || !review) return [];
    const out: Outcome[] = [];
    for (const q of stats.choice) {
        const unclear = sub.answers.find((a) => a.question === q.question);
        const got = (unclear ? [...(review.chosen.get(unclear.id) ?? [])] : [...q.marked]).sort((x, y) => x - y);
        const correct = got.length === q.answer.length && got.every((c, i) => c === q.answer[i]);
        out.push({ question: q.question, correct: got.length > 0 && correct, omitted: got.length === 0, points: correct ? q.points : 0 });
    }
    for (const { item, input } of sub.responses) {
        const typed = input.value.trim();
        const points = typed === "" || !Number.isFinite(Number(typed)) ? null : Math.max(0, Math.min(item.maxPoints, Math.round(Number(typed))));
        out.push({ question: item.question, correct: points === item.maxPoints, omitted: item.text === "", points });
    }
    return out;
}

/** A sheet's tally: correct and omitted counts, and the score out of the whole test's points. */
function sheetTally(sub: SubmissionReview): { correct: number; omitted: number; score: number; total: number } | null {
    const stats = sub.name.stats;
    if (!stats) return null;
    const outcomes = sheetOutcomes(sub);
    return {
        correct: outcomes.filter((o) => o.correct).length,
        omitted: outcomes.filter((o) => o.omitted).length,
        score: outcomes.reduce((n, o) => n + (o.points ?? 0), 0),
        total: stats.total,
    };
}

/** Updates every sheet's stat strip. */
function refreshStats(): void {
    if (!review) return;
    for (const sub of review.subs) {
        const t = sheetTally(sub);
        if (!t || !sub.stats) continue;
        sub.stats.correct.textContent = `Correct: ${t.correct}`;
        sub.stats.omitted.textContent = `Omitted: ${t.omitted}`;
        sub.stats.percent.textContent = `${t.total ? (Math.round((t.score / t.total) * 1000) / 10).toFixed(1) : "0.0"}%`;
        sub.stats.points.textContent = `${t.score}/${t.total}`;
    }
}

/** Shows every sheet, or only those with flags, per the view toggle. */
function applyReviewView(): void {
    if (!review) return;
    const all = $<HTMLInputElement>("view-all").checked;
    for (const s of review.subs) show(s.li, all || s.flags.length > 0);
    show($("review-empty"), !all && !review.subs.some((s) => s.flags.length));
}

/** Switches to every sheet if `field` sits in a hidden one, so the user can see it. */
function revealIfHidden(field: HTMLElement): void {
    if (field.closest("li.d-none")) {
        $<HTMLInputElement>("view-all").checked = true;
        applyReviewView();
    }
}

function renderSubmission(sub: SubmissionReview, index: number, count: number): HTMLElement {
    const li = el("li", "card review-sheet shadow-sm");
    sub.li = li;
    const head = el("div", "card-header review-sheet-head");
    // The title: the sheet number and the student's name, with the file names under them.
    const title = el("div", "review-sheet-title");
    const nameLabel = el("span", "fw-semibold text-truncate");
    const showName = (name: string) => {
        nameLabel.textContent = name.trim() || "Name not read";
        nameLabel.classList.toggle("fg-secondary", !name.trim());
    };
    showName(sub.name.ocr ?? "");
    const line = el("div", "d-flex align-items-baseline gap-3");
    line.append(el("span", "fw-semibold text-nowrap", `Sheet ${index + 1} of ${count}`), nameLabel);
    title.append(line, el("div", "small fg-secondary font-monospace text-truncate", sub.name.files.join(", ")));
    head.append(title);
    for (const f of sub.flags) head.append(el("span", "badge theme-warning", f));
    const skip = el("button", "btn-sm btn-outline theme-secondary text-nowrap");
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

    const body = el("div", "card-body review-body");
    if (sub.name.stats) {
        const strip = el("div", "review-stats d-flex align-items-center flex-wrap gap-3");
        const correct = el("span", "badge badge-subtle theme-success");
        const omitted = el("span", "badge badge-subtle theme-secondary");
        const percent = el("span", "badge badge-outline theme-secondary ms-auto");
        const points = el("span", "badge theme-primary");
        strip.append(correct, omitted, percent, points);
        body.append(strip);
        sub.stats = { correct, omitted, percent, points };
    }
    const row = el("div", "row g-3 align-items-center");
    const imgCol = el("div", "sm:col-6");
    const img = el("img", "review-name-crop border rounded");
    img.src = reviewImageUrl(sub.name.image);
    img.alt = `Name box on ${sub.name.files[0]}`;
    img.addEventListener("error", () => img.replaceWith(el("span", "small fg-secondary", "No image of the name box")));
    imgCol.append(img);
    const inputCol = el("div", "sm:col-6");
    const input = el("input", "form-control");
    input.type = "text";
    input.value = sub.name.ocr ?? "";
    input.placeholder = "Type the student's name";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.ariaLabel = `Student name for ${sub.name.files[0]}`;
    input.addEventListener("input", () => {
        input.classList.remove("is-invalid");
        showName(input.value);
        updateReviewNotes();
    });
    sub.nameInput = input;
    const ocrNote =
        sub.name.ocr === null
            ? el("div", "form-text fg-danger", `Couldn't read the name: ${sub.name.error ?? "unknown error"}`)
            : el("div", "form-text", "Read from the sheet; correct it if it's wrong.");
    sub.dupNote = el("div", "form-text fg-warning d-none");
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
    title.append(el("span", "fw-semibold", `Question ${item.question}`), el("span", "fg-secondary", ` · written answer · ${item.file}`));

    const img = el("img", "review-response-crop border rounded");
    img.src = reviewImageUrl(item.image);
    img.alt = `Written answer to question ${item.question} on ${item.file}`;
    img.addEventListener("error", () => img.replaceWith(el("span", "small fg-secondary", "No image of the answer box")));

    const row = el("div", "row g-3 align-items-start mt-1");
    const textCol = el("div", "sm:col-9 small");
    if (item.text === null) textCol.append(el("div", "fg-danger", `Couldn't read the answer: ${item.error ?? "unknown error"}`));
    else {
        const read = el("div", "review-transcript");
        read.append(el("span", "fg-secondary", "Read as: "), item.text ? el("q", "", item.text) : el("em", "fg-secondary", "(blank)"));
        textCol.append(read);
        if (!item.legible) textCol.append(el("div", "fg-warning", "Some of the writing couldn't be read; check it against the image."));
        if (item.points !== null && item.feedback) textCol.append(el("div", "fg-secondary mt-1", item.feedback));
        if (item.points === null && item.error) textCol.append(el("div", "fg-danger mt-1", `Not graded: ${item.error}`));
    }
    const pointsCol = el("div", "sm:col-3");
    const group = el("div", "input-group input-group-sm");
    const input = el("input", "form-control text-end font-monospace");
    input.type = "number";
    input.min = "0";
    input.max = String(item.maxPoints);
    input.step = "1";
    input.value = item.points === null ? "" : String(item.points);
    input.placeholder = "?";
    input.ariaLabel = `Points for question ${item.question} on ${item.file}`;
    input.addEventListener("input", () => {
        input.classList.remove("is-invalid");
        refreshStats();
    });
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
    title.append(el("span", "fw-semibold", `Question ${item.question}`), el("span", "fg-secondary", ` · ${item.file}`));

    const pic = el("div", "review-question border rounded overflow-hidden");
    const img = el("img");
    img.src = reviewImageUrl(item.image);
    img.alt = `Question ${item.question} on ${item.file}`;
    img.width = item.width;
    img.height = item.height;
    img.style.height = "auto";
    pic.append(img);

    const choices = el("div", "d-flex flex-wrap align-items-center gap-3 mt-3");
    choices.role = "group";
    choices.ariaLabel = `Answer to question ${item.question}`;
    const none = el("span", "badge rounded-pill theme-warning", "Response Omitted");
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
        refreshStats();
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
        const check = el("input", "check m-0");
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
        revealIfHidden(firstBad);
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
    if (where) revealIfHidden(where.li);
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
    const b = el("span", "badge rounded-pill bg-2 fg-body border");
    b.append(el("i", `bi ${icon} me-1`), text);
    return b;
}

function alertBox(kind: string, icon: string, title: string, detail?: string): void {
    const box = $("result-alert");
    box.className = `alert theme-${kind}`;
    box.replaceChildren(el("i", `bi ${icon} me-1`), el("strong", "", title));
    if (detail) box.append(el("div", "small mt-1", detail));
}

/**
 * Draws the correct-response share per question from the reviewed sheets (skipped ones left out).
 * The question most students got right is primary, the one fewest got right is warning (both only
 * when the questions differ), and any nobody got right is danger, listed under the chart.
 */
function renderDifficulty(): void {
    const subs = (review?.subs ?? []).filter((s) => !s.skip && s.name.stats);
    const by = new Map<number, { correct: number; answered: number }>();
    for (const sub of subs) {
        for (const o of sheetOutcomes(sub)) {
            const t = by.get(o.question) ?? { correct: 0, answered: 0 };
            t.answered++;
            if (o.correct) t.correct++;
            by.set(o.question, t);
        }
    }
    const questions = [...by.entries()].sort((a, b) => a[0] - b[0]);
    show($("chart-card"), questions.length > 0);
    if (!questions.length) return;
    const rate = (t: { correct: number; answered: number }) => (t.answered ? t.correct / t.answered : 0);
    const rates = questions.map(([, t]) => rate(t));
    const best = Math.max(...rates);
    const worst = Math.min(...rates);
    const tone = (r: number): "danger" | "primary" | "warning" | "secondary" =>
        r === 0 ? "danger" : best > worst && r === best ? "primary" : best > worst && r === worst ? "warning" : "secondary";

    const none = questions.filter(([, t]) => t.correct === 0).map(([q]) => q);
    const label = (q: number, t: { correct: number; answered: number }) => `Question ${q}: ${t.correct} of ${t.answered} correct (${Math.round(rate(t) * 100)}%)`;
    const dense = questions.length > 30;
    const cols = questions.map(([q, t], i) => {
        const col = el("div", "difficulty-col");
        col.title = label(q, t);
        col.setAttribute("aria-label", label(q, t));
        const plot = el("div", "difficulty-plot");
        const bar = el("div", `difficulty-bar theme-${tone(rates[i]!)}`);
        bar.style.height = `${rates[i]! * 100}%`;
        plot.append(bar);
        // Label only the highlighted bars, at the tip.
        if (tone(rates[i]!) !== "secondary") {
            const v = el("span", "difficulty-value small", `${Math.round(rates[i]! * 100)}%`);
            v.style.bottom = `calc(${rates[i]! * 100}% + 4px)`;
            plot.append(v);
        }
        col.append(plot, el("div", "difficulty-tick small fg-secondary", !dense || q % 5 === 0 ? String(q) : ""));
        return col;
    });
    const axis = el("div", "difficulty-axis small fg-secondary");
    axis.append(el("span", "", "100%"), el("span", "", "50%"), el("span", "", "0"));
    const chart = $("difficulty-chart");
    chart.replaceChildren(axis, ...cols);
    chart.setAttribute("role", "group");
    chart.ariaLabel = `Share of students answering each question correctly. ${none.length ? `Nobody answered ${none.map((q) => `question ${q}`).join(", ")} correctly.` : ""}`;

    // Only the colours actually on the chart; fewest-correct is danger instead when nobody got those right.
    const used = new Set(rates.map(tone));
    const legend: [string, string][] = [];
    if (used.has("primary")) legend.push(["primary", "Easiest (most correct)"]);
    if (used.has("warning")) legend.push(["warning", "Hardest (fewest correct)"]);
    if (used.has("secondary")) legend.push(["secondary", "Other questions"]);
    if (used.has("danger")) legend.push(["danger", "No correct responses"]);
    $("difficulty-legend").replaceChildren(
        ...legend.map(([theme, text]) => {
            const item = el("span", "d-inline-flex align-items-center gap-1");
            item.append(el("span", `difficulty-swatch theme-${theme}`), text);
            return item;
        }),
    );

    show($("difficulty-none"), none.length > 0);
    if (none.length) {
        $("difficulty-none-list").textContent = `Nobody answered ${none.length === 1 ? "question" : "questions"} ${none.map((q) => `Q${q}`).join(", ")} correctly. Check the key for ${none.length === 1 ? "it" : "them"}, or reteach the material.`;
    }

    const tbody = $<HTMLTableElement>("difficulty-table").tBodies[0]!;
    tbody.replaceChildren(
        ...questions.map(([q, t]) => {
            const tr = el("tr");
            tr.append(el("td", "", `Q${q}`), el("td", "text-end", String(t.correct)), el("td", "text-end", String(t.answered)), el("td", "text-end", `${Math.round(rate(t) * 100)}%`));
            return tr;
        }),
    );
}

function showResults(e: Extract<JobEvent, { type: "done" }>): void {
    const s = summarizeStderr(log);
    csvText = e.csv;
    show($("results-empty"), false);
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

    renderDifficulty();
    renderTable(e.csv);
    $("results-header-summary").textContent = `${plural(rows.length, "student")} graded${s.skipped.length ? `, ${s.skipped.length} skipped` : ""}`;
    renderSkipped(s.skipped, e.images);
    renderImages(e.images);
}

interface Row {
    name: string;
    /** The score as graded, before any curve. `score` is `base + curve`. */
    base: number;
    /** Points given in Curve Scores; set (not added to) each time a curve is applied. */
    curve: number;
    /** The reviewed sheet this row came from, for the "responded to question N" shortcut. */
    sub?: SubmissionReview;
    score: number;
    total: number;
    percent: number;
    percentText: string;
    /** Per free-response question, in column order: points, transcript and the grading reason. */
    free: { points: string; text: string; feedback: string }[];
}
let rows: Row[] = [];
/** The CLI's CSV as parsed, and as text; a curve rewrites each curved row's score and percent. */
let csvTable: string[][] = [];
let csvOriginal = "";
/** Rows ticked in the Curve Scores table, by index into `rows`. */
let curveSelected = new Set<number>();
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
    csvTable = [header, ...body];
    csvOriginal = csv;
    rows = body.map(([name = "", score = "", total = "", percent = "", ...rest]) => ({
        name,
        base: Number(score),
        curve: 0,
        score: Number(score),
        total: Number(total),
        percent: Number(percent),
        percentText: percent,
        free: freeQuestions.map((_, k) => ({ points: rest[3 * k] ?? "", text: rest[3 * k + 1] ?? "", feedback: rest[3 * k + 2] ?? "" })),
    }));
    show($("results-card"));
    // Tie each row to its reviewed sheet: the first unused, unskipped sheet with that name.
    const unused = (review?.subs ?? []).filter((s) => !s.skip && s.name.stats);
    for (const r of rows) {
        const i = unused.findIndex((s) => s.nameInput.value.trim() === r.name.trim());
        if (i >= 0) r.sub = unused.splice(i, 1)[0]!;
    }
    curveSelected = new Set();
    renderBadges();
    renderRows();
    renderCurve();
}

function renderBadges(): void {
    const pct = rows.map((r) => r.percent);
    const avg = pct.length ? pct.reduce((a, b) => a + b, 0) / pct.length : 0;
    $("result-badges").replaceChildren(
        badge("bi-people", `${plural(rows.length, "student")} graded`),
        ...(rows.length
            ? [badge("bi-bar-chart", `Average ${avg.toFixed(1)}%`), badge("bi-arrows-expand", `Range ${Math.min(...pct).toFixed(1)}–${Math.max(...pct).toFixed(1)}%`)]
            : []),
        badge("bi-list-ol", rows[0] ? `Out of ${plural(rows[0].total, "point")}` : "No rows"),
    );
}

// ---- Curve scores ------------------------------------------------------------
// A curve is points given on top of a student's base score. Applying one sets it (never adds to
// an earlier one), and the score is always recomputed from the base, so reapplying can't stack.

/** Recomputes a row's score and percent from its base and curve, formatted like the grader's CSV. */
function rescore(r: Row): void {
    r.score = r.base + r.curve;
    r.percent = r.total ? Math.round((r.score / r.total) * 1000) / 10 : 0;
    r.percentText = r.percent.toFixed(1);
}

/** The CSV the Copy and download buttons use: the CLI's own until a curve changes a row. */
function rebuildCsv(): void {
    if (rows.every((r) => !r.curve)) {
        csvText = csvOriginal;
        return;
    }
    const [header, ...body] = csvTable;
    csvText = [
        header!,
        ...body.map((fields, i) => {
            const r = rows[i]!;
            if (!r.curve) return fields;
            const out = [...fields];
            out[1] = String(r.score);
            out[3] = r.percentText;
            return out;
        }),
    ]
        .map(csvRow)
        .join("");
}

function renderCurve(): void {
    const questions = [...new Set(rows.flatMap((r) => (r.sub ? sheetOutcomes(r.sub).map((o) => o.question) : [])))].sort((a, b) => a - b);
    show($("curve-shortcut"), questions.length > 0);
    const select = $<HTMLSelectElement>("curve-question");
    const keep = select.value;
    select.replaceChildren(...questions.map((q) => Object.assign(el("option", "", `Q${q}`), { value: String(q) })));
    if (keep && questions.includes(Number(keep))) select.value = keep;

    const body = $<HTMLTableElement>("curve-table").tBodies[0]!;
    body.replaceChildren(
        ...rows.map((r, i) => {
            const tr = el("tr");
            const td = el("td", "curve-check");
            const box = el("input", "check");
            box.type = "checkbox";
            box.checked = curveSelected.has(i);
            box.ariaLabel = `Select ${r.name}`;
            box.addEventListener("change", () => {
                if (box.checked) curveSelected.add(i);
                else curveSelected.delete(i);
                renderCurveSelection();
            });
            td.append(box);
            tr.append(
                td,
                el("td", "", r.name),
                el("td", "text-end font-monospace", String(r.base)),
                el("td", "text-end font-monospace", r.curve ? (r.curve > 0 ? `+${r.curve}` : String(r.curve)) : "–"),
                el("td", "text-end font-monospace", String(r.score)),
            );
            return tr;
        }),
    );
    const curved = rows.filter((r) => r.curve).length;
    $("curve-summary").textContent = curved ? `${plural(curved, "student")} curved` : "";
    renderCurveSelection();
}

/** The select-all box, its label and the count, after the selection changes. */
function renderCurveSelection(): void {
    const all = $<HTMLInputElement>("curve-all");
    all.checked = rows.length > 0 && curveSelected.size === rows.length;
    all.indeterminate = curveSelected.size > 0 && curveSelected.size < rows.length;
    $("curve-all-label").textContent = all.checked ? "Select None" : "Select All";
    $("curve-count").textContent = `${curveSelected.size} of ${rows.length} students selected`;
    $("curve-error").textContent = "";
    const boxes = $<HTMLTableElement>("curve-table").tBodies[0]!.querySelectorAll<HTMLInputElement>("input.check");
    boxes.forEach((b, i) => (b.checked = curveSelected.has(i)));
}

function applyCurve(): void {
    const error = $("curve-error");
    const typed = $<HTMLInputElement>("curve-points").value.trim();
    const points = Number(typed);
    if (typed === "" || !Number.isInteger(points)) return void (error.textContent = "Give a whole number of points.");
    if (!curveSelected.size) return void (error.textContent = "Select at least one student.");
    for (const i of curveSelected) {
        rows[i]!.curve = points;
        rescore(rows[i]!);
    }
    rebuildCsv();
    renderBadges();
    renderRows();
    renderCurve();
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
        const btn = el("button", "btn-link btn-sm p-0 fw-semibold fg-body text-decoration-none", c.label);
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
            const score = el("td", "text-end font-monospace", String(r.score));
            if (r.curve) score.append(" ", el("span", `badge badge-subtle ${r.curve > 0 ? "theme-primary" : "theme-warning"}`, `${r.curve > 0 ? "+" : ""}${r.curve}`));
            row.append(el("td", "", r.name), score, el("td", "text-end font-monospace", String(r.total)));
            const pct = el("td", "text-end");
            const bar = el("div", "d-flex align-items-center justify-content-end gap-3");
            const meter = el("div", "progress grade-meter d-none sm:d-flex");
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
                if (x.feedback) more.append(el("div", "fg-secondary mt-1", x.feedback));
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
            head.append(el("span", `badge ${s.orphan ? "theme-secondary" : "theme-warning"} me-1`, s.orphan ? "Orphan pages" : "Submission"));
            for (const f of s.files) {
                const img = debugImageName(f);
                if (have.has(img)) {
                    const a = el("a", "small font-monospace me-3", f);
                    a.href = imageUrl(img);
                    a.target = "_blank";
                    a.rel = "noopener";
                    a.title = "Open the diagnostic image";
                    head.append(a);
                } else head.append(el("span", "small font-monospace me-3", f));
            }
            const ul = el("ul", "small mb-0 ps-5");
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
            a.append(img, el("div", "small fg-secondary text-truncate mt-1", name));
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
    // Starting a run needs a plan that can grade; say so up front rather than after the upload.
fetch("/api/me")
    .then((r) => (r.ok ? (r.json() as Promise<{ user: { canGrade: boolean } }>) : null))
    .then((me) => {
        if (me && !me.user.canGrade) show($("plan-warning"));
    })
    .catch(() => {});

renderInput();
});
$("btn-test-file").addEventListener("click", () => testFile.click());
$("btn-test-library").addEventListener("click", async () => {
    const m = await pickMaterial();
    if (m) void chooseTest(new File([m.content ?? ""], `${m.name.replace(/[^\w.\- ]+/g, "_").trim() || "test"}.json`, { type: "application/json" }));
});
testFile.addEventListener("change", () => {
    const f = testFile.files?.[0];
    testFile.value = "";
    if (f) void chooseTest(f);
});
for (const o of [optMark, optBlank, optDebug]) o.addEventListener("input", updateCommand);
$("btn-grade").addEventListener("click", () => void grade());
// These two sit inside the status bar's <summary>; keep their clicks from toggling it.
$("btn-cancel-run").addEventListener("click", (e) => {
    e.preventDefault();
    cancel();
});
$("curve-all").addEventListener("change", () => {
    curveSelected = $<HTMLInputElement>("curve-all").checked ? new Set(rows.keys()) : new Set();
    renderCurveSelection();
});
$("btn-curve-select").addEventListener("click", () => {
    const q = Number($<HTMLSelectElement>("curve-question").value);
    const wantCorrect = $<HTMLSelectElement>("curve-result").value === "correct";
    // Only the students who meet the condition; one whose sheet lacks the question meets neither.
    curveSelected = new Set(
        rows.flatMap((r, i) => {
            const o = r.sub && sheetOutcomes(r.sub).find((x) => x.question === q);
            return o && o.correct === wantCorrect ? [i] : [];
        }),
    );
    renderCurveSelection();
});
$("btn-curve-apply").addEventListener("click", applyCurve);
$("btn-view-results").addEventListener("click", (e) => {
    e.preventDefault();
    openPanel("panel-results");
});
$("btn-continue").addEventListener("click", () => openPanel("panel-test"));
$("btn-back").addEventListener("click", () => openPanel("panel-sheets"));
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="review-view"]')) r.addEventListener("change", applyReviewView);
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
    .then((r) => {
        if (r.status === 401) location.assign(`/login?next=${encodeURIComponent(location.pathname)}`);
        return r.json() as Promise<{ missing: string[]; thresholds: { markThreshold: number; blankThreshold: number } }>;
    })
    .then((info) => {
        optMark.placeholder = `${info.thresholds.markThreshold} (default)`;
        optBlank.placeholder = `${info.thresholds.blankThreshold} (default)`;
        if (info.missing.length) {
            $("config-missing").textContent = info.missing.join(" and ");
            show($("config-warning"));
        }
    })
    .catch(() => inputError("Couldn't reach the grader server. Start it with `bun run web`."));

// Starting a run needs a plan that can grade; say so up front rather than after the upload.
fetch("/api/me")
    .then((r) => (r.ok ? (r.json() as Promise<{ user: { canGrade: boolean } }>) : null))
    .then((me) => {
        if (me && !me.user.canGrade) show($("plan-warning"));
    })
    .catch(() => {});

renderInput();
