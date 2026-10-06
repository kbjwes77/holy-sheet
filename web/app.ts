// Sheet Generator UI: validates pasted/loaded sheet JSON, renders the pages with the shared
// reference renderer (same geometry the grader reads), and prints or exports them as a PDF.
import { jsPDF } from "jspdf";
import "svg2pdf.js";
import example from "../examples/ap-macro-unit-4.json";
import { renderSeparate } from "../gen/booklet.ts";
import { renderTest, type TestDef } from "../gen/sheet.ts";
import { parseSheetJson, type ValidationIssue } from "../gen/testdef.ts";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const LETTER_PT = { w: 612, h: 792 };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const input = $<HTMLTextAreaElement>("json-input");
const fileInput = $<HTMLInputElement>("file-input");
const dropZone = $("drop-zone");
const inputStatus = $("input-status");
const errorsBox = $("errors");
const errorsTitle = $("errors-title");
const errorsList = $<HTMLUListElement>("errors-list");
const emptyState = $("empty-state");
const output = $("output");
const stale = $("stale");
const previews = $("previews");
const printRoot = $("print-root");
const keyLine = $<HTMLInputElement>("key-line");
const answerSheet = $<HTMLInputElement>("answer-sheet");
const ANSWER_SHEET_KEY = "sheet-generator.answer-sheet";

interface Generated {
    source: string;
    test: TestDef;
    key: string | null;
    /** Whether every question has an answer, so the grader can grade from the JSON. */
    gradable: boolean;
    /** Free-response questions in the test. */
    free: number;
    /** Every page's SVG, in print order. */
    pages: string[];
    /** With a separate answer sheet, how many of `pages` are its (at the end); null otherwise. */
    answerPages: number | null;
}
let current: Generated | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
}

function setStatus(text: string): void {
    inputStatus.textContent = text || " ";
}

function slug(s: string): string {
    return (
        s
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "sheet"
    );
}

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

// ---- Errors ----------------------------------------------------------------

function issueItem(e: ValidationIssue, codeClass: string): HTMLLIElement {
    const li = el("li");
    li.append(el("strong", "", e.where), document.createTextNode(` — ${e.message}`));
    if (e.path) li.append(" ", el("code", codeClass, e.path));
    return li;
}

function showErrors(errors: ValidationIssue[]): void {
    showNotes([]);
    errorsList.replaceChildren(...errors.map((e) => issueItem(e, "text-danger-emphasis")));
    errorsTitle.textContent =
        errors.length === 1 ? "The sheet couldn't be generated:" : `The sheet couldn't be generated (${errors.length} problems):`;
    errorsBox.classList.remove("d-none");
    errorsBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function hideErrors(): void {
    errorsBox.classList.add("d-none");
}

/** Non-blocking remarks about a sheet that was generated (e.g. an unused figure). */
function showNotes(notes: ValidationIssue[]): void {
    $("notes-list").replaceChildren(...notes.map((n) => issueItem(n, "text-info-emphasis")));
    $("notes").firstElementChild!.lastChild!.textContent = notes.length === 1 ? "Generated, with a note:" : `Generated, with ${notes.length} notes:`;
    $("notes").classList.toggle("d-none", !notes.length);
}

// ---- Generate --------------------------------------------------------------

function generate(): void {
    const source = input.value;
    const separate = answerSheet.checked;
    const result = parseSheetJson(source, { answerSheet: separate });
    if (!result.ok) {
        showErrors(result.errors);
        return;
    }
    hideErrors();
    showNotes(result.notes);
    let pages: string[];
    let answerPages: number | null = null;
    if (separate) {
        const s = renderSeparate(result.test);
        pages = [...s.questionPages, ...s.answerPages.map((p) => p.svg)];
        answerPages = s.answerPages.length;
    } else {
        pages = renderTest(result.test).map((p) => p.svg);
    }
    const free = result.test.questions.filter((q) => q.lines !== undefined).length;
    current = { source, test: result.test, key: result.key, gradable: !!result.grading, free, pages, answerPages };
    showOutput(current);
}

function badge(icon: string, text: string): HTMLElement {
    const b = el("span", "badge rounded-pill text-bg-light border");
    b.append(el("i", `bi ${icon} me-1`), text);
    return b;
}

function showOutput(g: Generated): void {
    emptyState.classList.add("d-none");
    output.classList.remove("d-none");
    stale.classList.add("d-none");

    $("out-title").textContent = g.test.title;
    const n = g.test.questions.length;
    const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
    const answers = g.answerPages;
    $("out-badges").replaceChildren(
        badge("bi-list-ol", plural(n, "question")),
        ...(answers === null
            ? [badge("bi-files", `${plural(g.pages.length, "page")} per student`)]
            : [badge("bi-files", `${plural(g.pages.length - answers, "question page")} + ${plural(answers, "answer sheet page")}`), badge("bi-upc-scan", `Scan ${plural(answers, "page")} per student`)]),
        badge("bi-file-earmark", "US Letter"),
        ...(g.free ? [badge("bi-pencil", `${g.free} free response`)] : []),
        badge(g.gradable ? "bi-key" : "bi-key-fill", g.gradable ? "Answer key included" : "No answer key"),
    );
    $("print-help").classList.toggle("d-none", answers !== null);
    $("print-help-separate").classList.toggle("d-none", answers === null);

    // A letter key only for all multiple-choice tests; free-response ones grade from the JSON.
    $("key-group").classList.toggle("d-none", !g.key);
    $("key-none").classList.toggle("d-none", g.gradable);
    keyLine.value = g.key ?? "";
    const help = g.key
        ? "Paste this line when the command-line grader asks for the answer key."
        : g.gradable
          ? "This test has free-response questions, so it's graded from its JSON (the grader's --test), not a key line."
          : "";
    $("key-help").textContent = help;
    $("key-help").classList.toggle("d-none", !help);
    $("test-help").textContent = g.gradable
        ? "The web grader grades from this file."
        : "The web grader needs this file with an answer for every question.";

    const firstAnswer = answers === null ? Infinity : g.pages.length - answers;
    previews.replaceChildren(
        ...g.pages.map((svg, i) => {
            const wrap = el("figure", "sheet-preview");
            const paper = el("div", "paper");
            paper.innerHTML = svg;
            const kind = answers === null ? "" : i >= firstAnswer ? " · Answer sheet (scanned)" : " · Questions";
            wrap.append(paper, el("figcaption", "small text-body-secondary text-center mt-2", `Page ${i + 1} of ${g.pages.length}${kind}`));
            return wrap;
        }),
    );
    printRoot.replaceChildren(
        ...g.pages.map((svg) => {
            const page = el("div", "print-page");
            page.innerHTML = svg;
            return page;
        }),
    );
}

// ---- Print / PDF / key -----------------------------------------------------

async function downloadPdf(): Promise<void> {
    if (!current) return;
    const btn = $<HTMLButtonElement>("btn-pdf");
    btn.disabled = true;
    $("pdf-spinner").classList.remove("d-none");
    $("pdf-icon").classList.add("d-none");
    try {
        const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
        doc.setProperties({ title: current.test.title, creator: "Sheet Generator" });
        for (const [i, page] of current.pages.entries()) {
            if (i > 0) doc.addPage("letter", "portrait");
            const svg = new DOMParser().parseFromString(page, "image/svg+xml").documentElement;
            await doc.svg(svg, { x: 0, y: 0, width: LETTER_PT.w, height: LETTER_PT.h });
        }
        download(`${slug(current.test.title)}.pdf`, doc.output("blob"));
    } catch (e) {
        showErrors([{ path: "", where: "PDF", message: `Couldn't build the PDF: ${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
        btn.disabled = false;
        $("pdf-spinner").classList.add("d-none");
        $("pdf-icon").classList.remove("d-none");
    }
}

async function copyKey(): Promise<void> {
    if (!current?.key) return;
    try {
        await navigator.clipboard.writeText(current.key);
    } catch {
        keyLine.select();
        document.execCommand("copy");
    }
    const icon = $("copy-icon");
    icon.className = "bi bi-clipboard-check";
    setTimeout(() => (icon.className = "bi bi-clipboard"), 1500);
}

/** Copies the Format help as rich text (HTML) with a plain-text fallback, without the button. */
async function copyFormatHelp(): Promise<void> {
    const help = document.querySelector<HTMLElement>(".format-help");
    if (!help) return;
    const clone = help.cloneNode(true) as HTMLElement;
    clone.querySelector(".format-copy")?.remove();
    const html = clone.innerHTML.trim();
    const text = help.innerText.replace(/^\s*Copy\s*/, "").trim();
    try {
        await navigator.clipboard.write([
            new ClipboardItem({
                "text/html": new Blob([html], { type: "text/html" }),
                "text/plain": new Blob([text], { type: "text/plain" }),
            }),
        ]);
    } catch {
        await navigator.clipboard.writeText(text).catch(() => {});
    }
    const icon = $("copy-format-icon");
    icon.className = "bi bi-clipboard-check";
    setTimeout(() => (icon.className = "bi bi-clipboard"), 1500);
}

// ---- Input -----------------------------------------------------------------

async function loadFile(file: File): Promise<void> {
    if (file.size > MAX_FILE_BYTES) {
        showErrors([{ path: "", where: file.name, message: `File is too large (${Math.round(file.size / 1024)} KB, max 2 MB).` }]);
        return;
    }
    input.value = await file.text();
    hideErrors();
    markStale();
    setStatus(`Loaded ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
}

function markStale(): void {
    if (current) stale.classList.toggle("d-none", input.value === current.source);
}

// The separate answer sheet setting is remembered in this browser; changing it regenerates a shown sheet.
try {
    answerSheet.checked = localStorage.getItem(ANSWER_SHEET_KEY) === "1";
} catch {
    // Storage unavailable (e.g. blocked for file:// pages): start off.
}
answerSheet.addEventListener("change", () => {
    try {
        localStorage.setItem(ANSWER_SHEET_KEY, answerSheet.checked ? "1" : "0");
    } catch {
        // Not remembered, but still applies now.
    }
    if (current) generate();
});

$("btn-generate").addEventListener("click", generate);
$("btn-print").addEventListener("click", () => window.print());
$("btn-pdf").addEventListener("click", () => void downloadPdf());
$("btn-copy-key").addEventListener("click", () => void copyKey());
$("btn-copy-format").addEventListener("click", () => void copyFormatHelp());
$("btn-download-key").addEventListener("click", () => {
    if (current?.key) download(`${slug(current.test.title)}-key.txt`, new Blob([`${current.key}\n`], { type: "text/plain" }));
});
// The JSON the sheets were generated from, as the web grader's test file.
$("btn-download-test").addEventListener("click", () => {
    if (current) download(`${slug(current.test.title)}.json`, new Blob([current.source], { type: "application/json" }));
});

$("btn-load").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void loadFile(file);
    fileInput.value = "";
});
$("btn-example").addEventListener("click", () => {
    input.value = JSON.stringify(example, null, 2) + "\n";
    hideErrors();
    markStale();
    setStatus("Loaded example: ap-macro-unit-4.json");
});
$("btn-clear").addEventListener("click", () => {
    input.value = "";
    hideErrors();
    markStale();
    setStatus("");
    input.focus();
});

input.addEventListener("input", () => {
    markStale();
    setStatus("");
});
input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        generate();
    }
});

let dragDepth = 0;
dropZone.addEventListener("dragenter", (e) => {
    e.preventDefault();
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
    const file = e.dataTransfer?.files[0];
    if (file) void loadFile(file);
});
