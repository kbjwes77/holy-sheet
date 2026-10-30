// Print Sheets UI: validates pasted/loaded sheet JSON, renders the pages with the shared
// reference renderer (same geometry the grader reads), and prints or exports them as a PDF.
import { jsPDF } from "jspdf";
import "svg2pdf.js";
import example from "../examples/ap-macro-unit-4.json";
import { renderSeparate } from "../gen/booklet.ts";
import { isFree, renderTest, type SheetType, type SolutionPlacement, type TestDef } from "../gen/sheet.ts";
import { parseSheetJson, type ValidationIssue } from "../gen/testdef.ts";
import { copyText, openAiPrompt } from "./ai-dialog.ts";
import { extractJson, formatGuideForAi } from "./ai-prompt.ts";
import { startPage, type Material } from "./common.ts";
import { editMaterial, pickMaterial } from "./library-dialogs.ts";

const { me } = await startPage("generator");

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
const answerSheetInline = $<HTMLInputElement>("answer-sheet-inline");
const answerSheetRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="answer-sheet"]')];
const answerSheetGroup = answerSheet.closest<HTMLElement>(".form-group")!;
const twoColumns = $<HTMLInputElement>("two-columns");
const twoColumnsFull = $<HTMLInputElement>("two-columns-full");
const twoColumnRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="two-columns"]')];
const solutions = $<HTMLSelectElement>("solutions");
const teacherCopy = $<HTMLInputElement>("teacher-copy");
const teacherExplanations = $<HTMLInputElement>("teacher-explanations");
const teacherExplanationsField = $("teacher-explanations-field");
const keyNone = $("key-none");
const KEY_NONE_DEFAULT = keyNone.innerHTML;
const ANSWER_SHEET_KEY = "sheet-generator.answer-sheet";
const TWO_COLUMNS_KEY = "sheet-generator.two-columns";
const SOLUTIONS_KEY = "sheet-generator.solutions";
const TEACHER_COPY_KEY = "sheet-generator.teacher-copy";
const TEACHER_EXPLANATIONS_KEY = "sheet-generator.teacher-explanations";

interface Generated {
    source: string;
    test: TestDef;
    key: string | null;
    /** Whether every question has an answer, so the grader can grade from the JSON. */
    gradable: boolean;
    /** The root JSON's type, or what the questions imply. */
    sheetType: SheetType;
    /** A study guide: nothing is graded and no answer sheet applies. */
    studyGuide: boolean;
    /** Free-response questions in the test. */
    free: number;
    /** Every page's SVG, in print order. */
    pages: string[];
    /** With a separate answer sheet, how many of `pages` are its (at the end); null otherwise. */
    answerPages: number | null;
    /** Blank pages printed between the question pages and the answer sheet. */
    blankPages: number;
}
let current: Generated | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
}

/** The status line under the editor: a short note about what just happened, then whether the JSON checks out. */
const statusNote = el("span");
const statusValidity = el("span", "d-block");
inputStatus.replaceChildren(statusNote, statusValidity);

function setStatus(text: string): void {
    statusNote.textContent = text ? `${text} ` : "";
    if (!text) statusValidity.replaceChildren();
}

/** Puts text in the editor (a loaded file, an example, a library material) and checks it. */
function setInput(text: string): void {
    input.value = text;
    syncStarter();
    validateNow();
}

/** The checklist of options over an empty editor: shown only while the box is empty and not being typed in. */
const starter = $("editor-starter");
function syncStarter(): void {
    starter.hidden = input.value.trim() !== "" || document.activeElement === input;
}

/** If the box holds a chatbot's whole reply (code fences, "Here's your quiz!"), keeps just the JSON. Returns whether it changed. */
function tidyPaste(): boolean {
    const { text, cleaned } = extractJson(input.value);
    if (!cleaned) return false;
    input.value = text;
    setStatus("Removed the extra text around the JSON.");
    return true;
}

const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;

function validity(ok: boolean, text: string, detail = ""): void {
    const icon = el("i", `bi ${ok ? "bi-check-circle-fill" : "bi-exclamation-circle-fill"} me-1`);
    const span = el("span", ok ? "fg-success" : "fg-danger");
    span.append(icon, text);
    statusValidity.replaceChildren(span, ...(detail ? [document.createTextNode(` ${detail}`)] : []));
}

/** Checks the JSON as the teacher types, so a mistake shows up before they press Print sheets. */
let validateTimer: ReturnType<typeof setTimeout> | undefined;
function validateSoon(): void {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(validateNow, 500);
}
function validateNow(): void {
    clearTimeout(validateTimer);
    if (!input.value.trim()) return statusValidity.replaceChildren();
    const { text } = extractJson(input.value);
    const result = parseSheetJson(text, { layout: false, solutions: solutions.value as SolutionPlacement, teacherCopy: teacherCopy.checked });
    if (!result.ok) {
        const first = result.errors[0]!;
        const more = result.errors.length > 1 ? ` (and ${plural(result.errors.length - 1, "more problem")})` : "";
        return validity(false, first.where === "JSON syntax" ? "Not valid JSON yet:" : `${first.where}:`, `${first.message}${more}`);
    }
    const n = result.test.questions.length;
    const answers = result.studyGuide ? "" : result.grading ? ", answer key included" : ", no answers yet";
    validity(true, "Looks good:", `${result.sheetType}, ${plural(n, "question")}${answers}. Choose Print sheets.`);
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
        errors.length === 1 ? "The sheet couldn't be printed:" : `The sheet couldn't be printed (${errors.length} problems):`;
    errorsBox.classList.remove("d-none");
    errorsBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function hideErrors(): void {
    errorsBox.classList.add("d-none");
}

/** Non-blocking remarks about a sheet that was prepared (e.g. an unused figure). */
function showNotes(notes: ValidationIssue[]): void {
    $("notes-list").replaceChildren(...notes.map((n) => issueItem(n, "text-info-emphasis")));
    $("notes").firstElementChild!.lastChild!.textContent = notes.length === 1 ? "Sheet ready, with a note:" : `Sheet ready, with ${notes.length} notes:`;
    $("notes").classList.toggle("d-none", !notes.length);
}

// ---- Print -----------------------------------------------------------------

function generate(): void {
    tidyPaste();
    syncStarter();
    const source = input.value;
    const result = parseSheetJson(source, {
        answerSheet: answerSheet.checked,
        singleColumn: !twoColumns.checked,
        solutions: solutions.value as SolutionPlacement,
        teacherCopy: teacherCopy.checked,
        explanations: teacherExplanations.checked,
    });
    if (!result.ok) {
        showErrors(result.errors);
        return;
    }
    hideErrors();
    showNotes(result.notes);
    collapseHowItWorks();
    // A study guide has nothing to grade, so neither answer-sheet choice applies.
    for (const radio of answerSheetRadios) radio.disabled = result.studyGuide;
    answerSheetGroup.title = result.studyGuide
        ? "A study guide isn't marked or graded, so there's no answer sheet."
        : "Print the questions on plain pages, with every answer on an answer sheet at the end. Only the answer sheet is scanned.";
    const separate = answerSheet.checked && !result.studyGuide;
    let pages: string[];
    let answerPages: number | null = null;
    let blankPages = 0;
    if (separate) {
        const s = renderSeparate(result.test);
        pages = [...s.questionPages, ...(s.blankPage ? [s.blankPage] : []), ...s.answerPages.map((p) => p.svg)];
        blankPages = s.blankPage ? 1 : 0;
        answerPages = s.answerPages.length;
    } else {
        pages = renderTest(result.test).map((p) => p.svg);
    }
    const free = result.test.questions.filter(isFree).length;
    current = {
        source,
        test: result.test,
        key: result.key,
        gradable: !!result.grading,
        sheetType: result.sheetType,
        studyGuide: result.studyGuide,
        free,
        pages,
        answerPages,
        blankPages,
    };
    showOutput(current);
}

function badge(icon: string, text: string): HTMLElement {
    const b = el("span", "badge rounded-pill bg-2 fg-body border");
    b.append(el("i", `bi ${icon} me-1`), text);
    return b;
}

/** A short "what happens next" for someone printing their first test: print, hand out, scan, grade. */
function renderNextSteps(g: Generated): void {
    const li = (...parts: (string | Node)[]) => {
        const item = el("li");
        item.append(...parts);
        return item;
    };
    const gradeLink = () => {
        const a = el("a", "", "Grade Sheets");
        a.href = "/grader";
        return a;
    };
    const steps: HTMLLIElement[] = [];
    if (g.studyGuide) {
        steps.push(li("Print it, or download the PDF to share. A study guide has no bubbles, so there is nothing to scan or grade."));
    } else if (!g.gradable) {
        steps.push(
            li("Print and hand out the sheets as they are, or first add an ", el("code", "", '"answer"'), " to every question so they can be scored automatically."),
            li("Tip: paste your test back into an AI chatbot and ask it to add the answers, then check them."),
        );
    } else {
        steps.push(
            li("Print one copy per student, or download the PDF."),
            li("Students fill in the bubbles for their answers, and write their name in the Name box."),
            li("Scan the finished sheets (a phone photo is fine), keeping each student's pages together with page 1 first."),
            li("Open ", gradeLink(), " and add the scans and the ", el("strong", "", "test.json"), " saved below. You get every score in a table."),
        );
        if (!me.canGrade) steps.push(li("Grading is part of the Pro plan", me.billing.trialAvailable ? " (7-day free trial)." : "."));
    }
    $("next-steps-list").replaceChildren(...steps);
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
            : [
                  badge(
                      "bi-files",
                      `${plural(g.pages.length - answers - g.blankPages, "question page")}${g.blankPages ? ` + ${g.blankPages} blank` : ""} + ${plural(answers, "answer sheet page")}`,
                  ),
                  badge("bi-upc-scan", `Scan ${plural(answers, "page")} per student`),
              ]),
        badge("bi-file-earmark", "US Letter"),
        badge("bi-journal-text", g.sheetType),
        ...(g.free ? [badge("bi-pencil", `${g.free} free response`)] : []),
        ...(g.studyGuide ? [] : [badge(g.gradable ? "bi-key" : "bi-key-fill", g.gradable ? "Answer key included" : "No answer key")]),
    );
    renderNextSteps(g);
    $("print-help").classList.toggle("d-none", answers !== null);
    $("print-help-separate").classList.toggle("d-none", answers === null);

    // A letter key only for all multiple-choice tests; free-response ones grade from the JSON.
    $("key-details").classList.toggle("d-none", !g.key);
    $("btn-download-test").classList.toggle("d-none", g.studyGuide);
    $("key-none").classList.toggle("d-none", g.gradable);
    keyNone.innerHTML = g.studyGuide
        ? "This is a study guide: nothing is marked or graded, so there's no answer key. Its answers and explanations print as solutions."
        : KEY_NONE_DEFAULT;
    keyLine.value = g.key ?? "";
    const help = g.key
        ? "Paste this line when the command-line grader asks for the answer key."
        : g.gradable
          ? "This test has free-response questions, so it's graded from its JSON (the grader's --test), not a key line."
          : "";
    $("key-help").textContent = help;
    $("key-help").classList.toggle("d-none", !help);
    $("test-help").textContent = g.studyGuide
        ? "A study guide isn't graded, so there is nothing to save for grading."
        : g.gradable
          ? "Grade Sheets reads the right answers from this file when you grade the scans. Keep it with the printed sheets."
          : "Grade Sheets needs this file with an answer for every question before it can score the scans.";

    const firstAnswer = answers === null ? Infinity : g.pages.length - answers;
    previews.replaceChildren(
        ...g.pages.map((svg, i) => {
            const wrap = el("figure", "sheet-preview");
            const paper = el("div", "paper");
            paper.innerHTML = svg;
            const kind = answers === null ? "" : i >= firstAnswer ? " · Answer sheet (scanned)" : " · Questions";
            wrap.append(paper, el("figcaption", "small fg-secondary text-center mt-3", `Page ${i + 1} of ${g.pages.length}${kind}`));
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
        doc.setProperties({ title: current.test.title, creator: "Print Sheets" });
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

/** Copies the format rules as a message to paste into an AI chatbot (plain text, so it pastes cleanly into any chat box). */
async function copyFormatHelp(): Promise<void> {
    if (!(await copyText(formatGuideForAi()))) return;
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
    setInput(await file.text());
    hideErrors();
    markStale();
    setStatus(`Loaded ${file.name} (${(file.size / 1024).toFixed(1)} KB).`);
    if (tidyPaste()) validateNow();
}

function markStale(): void {
    if (current) stale.classList.toggle("d-none", input.value === current.source);
}

// The layout choices are remembered in this browser; changing one regenerates a shown sheet.
try {
    const separate = localStorage.getItem(ANSWER_SHEET_KEY) === "1";
    answerSheet.checked = separate;
    answerSheetInline.checked = !separate;
} catch {
    // Storage unavailable (e.g. blocked by the browser): keep the default, answers on the test.
}
try {
    const columns = localStorage.getItem(TWO_COLUMNS_KEY) !== "0";
    twoColumns.checked = columns;
    twoColumnsFull.checked = !columns;
} catch {
    // Storage unavailable: keep the default, two columns.
}
try {
    const saved = localStorage.getItem(SOLUTIONS_KEY);
    if (saved === "end" || saved === "inline" || saved === "none") solutions.value = saved;
} catch {
    // Storage unavailable: keep the default, solutions at the end.
}
for (const radio of twoColumnRadios) {
    radio.addEventListener("change", () => {
        if (!radio.checked) return;
        try {
            localStorage.setItem(TWO_COLUMNS_KEY, twoColumns.checked ? "1" : "0");
        } catch {
            // Not remembered, but still applies now.
        }
        if (current) generate();
    });
}
for (const radio of answerSheetRadios) {
    radio.addEventListener("change", () => {
        if (!radio.checked) return;
        try {
            localStorage.setItem(ANSWER_SHEET_KEY, answerSheet.checked ? "1" : "0");
        } catch {
            // Not remembered, but still applies now.
        }
        if (current) generate();
    });
}
/** Teacher's Copy locks Solutions to Inline; the user's own choice comes back when it is switched off. */
let solutionsChoice = solutions.value;
function syncTeacherCopy(): void {
    const on = teacherCopy.checked;
    teacherExplanationsField.classList.toggle("d-none", !on);
    solutions.disabled = on;
    solutions.value = on ? "inline" : solutionsChoice;
}
try {
    teacherCopy.checked = localStorage.getItem(TEACHER_COPY_KEY) === "1";
    teacherExplanations.checked = localStorage.getItem(TEACHER_EXPLANATIONS_KEY) !== "0";
} catch {
    // Storage unavailable: keep the defaults, off and with explanations.
}
syncTeacherCopy();
teacherCopy.addEventListener("change", () => {
    try {
        localStorage.setItem(TEACHER_COPY_KEY, teacherCopy.checked ? "1" : "0");
    } catch {
        // Not remembered, but still applies now.
    }
    syncTeacherCopy();
    if (current) generate();
});
teacherExplanations.addEventListener("change", () => {
    try {
        localStorage.setItem(TEACHER_EXPLANATIONS_KEY, teacherExplanations.checked ? "1" : "0");
    } catch {
        // Not remembered, but still applies now.
    }
    if (current) generate();
});
solutions.addEventListener("change", () => {
    solutionsChoice = solutions.value;
    try {
        localStorage.setItem(SOLUTIONS_KEY, solutions.value);
    } catch {
        // Not remembered, but still applies now.
    }
    if (current) generate();
});

const layoutOptions = $("layout-options");
const layoutButton = $<HTMLButtonElement>("btn-layout-options");
const layoutChevron = $("layout-chevron");
layoutButton.addEventListener("click", () => {
    const open = layoutOptions.classList.toggle("d-none") === false;
    layoutButton.setAttribute("aria-expanded", String(open));
    layoutChevron.className = `bi ${open ? "bi-chevron-up" : "bi-chevron-down"} ms-2`;
});

$("btn-generate").addEventListener("click", generate);
for (const b of document.querySelectorAll<HTMLElement>("[data-ai-prompt]")) b.addEventListener("click", () => void openAiPrompt());
// The starter's buttons do what the matching toolbar buttons do.
for (const b of document.querySelectorAll<HTMLElement>("[data-action]")) {
    const target = { example: "btn-example", load: "btn-load", library: "btn-open-library" }[b.dataset.action ?? ""];
    if (target) b.addEventListener("click", () => $(target).click());
}

// The how-it-works strip is open for a new visitor; once dismissed (or a first sheet is printed) it stays folded in this browser.
const HOW_KEY = "sheet-generator.how-it-works";
const how = $<HTMLDetailsElement>("how-it-works");
try {
    if (localStorage.getItem(HOW_KEY) === "closed") how.open = false;
} catch {
    // Storage unavailable: stay open.
}
function collapseHowItWorks(): void {
    how.open = false;
}
how.addEventListener("toggle", () => {
    try {
        localStorage.setItem(HOW_KEY, how.open ? "open" : "closed");
    } catch {
        // Not remembered.
    }
});
$("btn-hide-how").addEventListener("click", collapseHowItWorks);
$("btn-print").addEventListener("click", () => window.print());
$("btn-pdf").addEventListener("click", () => void downloadPdf());
$("btn-copy-key").addEventListener("click", () => void copyKey());
$("btn-copy-format").addEventListener("click", () => void copyFormatHelp());
$("btn-format-help").addEventListener("click", (e) => {
    const open = $("format-help").classList.toggle("d-none") === false;
    (e.currentTarget as HTMLElement).setAttribute("aria-expanded", String(open));
});
$("btn-download-key").addEventListener("click", () => {
    if (current?.key) download(`${slug(current.test.title)}-key.txt`, new Blob([`${current.key}\n`], { type: "text/plain" }));
});
// The JSON the sheets were built from, as the web grader's test file.
$("btn-download-test").addEventListener("click", () => {
    if (current) download(`${slug(current.test.title)}.json`, new Blob([current.source], { type: "application/json" }));
});

// ---- Library ----

const loadMaterial = (m: Material) => {
    if (m.type === "Slides") {
        showErrors([{ path: "", where: m.name, message: "This is a slide deck, not test JSON. Open it from My Library instead." }]);
        return;
    }
    setInput(m.content ?? "");
    hideErrors();
    markStale();
    setStatus(`Loaded "${m.name}" from the library.`);
    savedAs = m.mine ? m : null;
};
/** The library material the editor was loaded from (when it's the user's own), so Save updates it. */
let savedAs: Material | null = null;
$("btn-open-library").addEventListener("click", async () => {
    const m = await pickMaterial();
    if (m) loadMaterial(m);
});
/** The library type a sheet's root type maps to. */
const materialType = (t: SheetType): Material["type"] => (t === "Study Guide" ? "StudyGuide" : t);

$("btn-save-library").addEventListener("click", async () => {
    const parsed = parseSheetJson(input.value, { layout: false, solutions: solutions.value as SolutionPlacement });
    if (!parsed.ok) return showErrors(parsed.errors);
    hideErrors();
    try {
        const saved = await editMaterial(
            savedAs
                ? { material: savedAs, content: input.value, type: materialType(parsed.sheetType) }
                : { content: input.value, name: parsed.test.title, type: materialType(parsed.sheetType) },
        );
        if (saved) {
            savedAs = saved;
            setStatus(`Saved "${saved.name}" to your library.`);
        }
    } catch (e) {
        showErrors([{ path: "", where: "Library", message: e instanceof Error ? e.message : String(e) }]);
    }
});
// /generator?material=ID opens a saved or community material.
const id = new URLSearchParams(location.search).get("material");
if (id) {
    fetch(`/api/materials/${encodeURIComponent(id)}`).then(async (r) => {
        if (r.status === 401) return location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
        const m = (await r.json()) as Material & { error?: string };
        if (r.ok) loadMaterial(m);
        else showErrors([{ path: "", where: "Library", message: m.error ?? "couldn't open that material" }]);
    });
}

$("btn-load").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void loadFile(file);
    fileInput.value = "";
});
$("btn-example").addEventListener("click", () => {
    setInput(JSON.stringify(example, null, 2) + "\n");
    hideErrors();
    markStale();
    setStatus("Loaded an example test. Choose Print sheets to see how it looks, or edit it to make your own.");
});
$("btn-clear").addEventListener("click", () => {
    setInput("");
    hideErrors();
    markStale();
    setStatus("");
    input.focus();
});

input.addEventListener("input", () => {
    markStale();
    setStatus("");
    syncStarter();
    validateSoon();
});
starter.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("button")) input.focus();
});
input.addEventListener("focus", syncStarter);
input.addEventListener("blur", syncStarter);
// A chatbot's reply pasted whole: keep just the JSON, then say what happened.
input.addEventListener("paste", () => {
    setTimeout(() => {
        const cleaned = tidyPaste();
        syncStarter();
        markStale();
        validateNow();
        if (cleaned) input.scrollTop = 0;
    }, 0);
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

// A test started in the public free generator (/free-bubble-sheet-generator) arrives here once the teacher has an account.
try {
    const handoff = localStorage.getItem("gradelake.handoff");
    if (handoff) {
        localStorage.removeItem("gradelake.handoff");
        if (!input.value.trim()) {
            setInput(handoff);
            setStatus("Loaded the test you made in the free generator.");
        }
    }
} catch {}
