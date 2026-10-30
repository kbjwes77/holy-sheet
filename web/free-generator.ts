// The public, no-account bubble sheet generator. Two ways to write the same Test JSON:
//   Simple    boxes, sliders and buttons build the JSON (model in free-generator-model.ts)
//   Advanced  the JSON itself, with live checking
// Either way the sheet is drawn by the same code the app uses, in the browser; nothing is uploaded.
import { jsPDF } from "jspdf";
import "svg2pdf.js";
import figuresExample from "../examples/figures-demo.json";
import { renderSeparate } from "../gen/booklet.ts";
import { renderTest } from "../gen/sheet.ts";
import { parseSheetJson, type ValidationIssue } from "../gen/testdef.ts";
import { copyText } from "./ai-dialog.ts";
import { buildPrompt, DEFAULTS, extractJson, MINI_EXAMPLE, type Kind, type Style } from "./ai-prompt.ts";
import {
    hasExtras,
    importDoc,
    letter,
    MAX_CHOICES,
    MAX_SIMPLE_QUESTIONS,
    MIN_CHOICES,
    missingAnswers,
    newQuestion,
    newState,
    toDoc,
    type SheetKind,
    type SimpleQuestion,
    type SimpleState,
} from "./free-generator-model.ts";

const LETTER_PT = { w: 612, h: 792 };
const DRAFT_KEY = "gradelake.free.draft";
const HANDOFF_KEY = "gradelake.handoff";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
}
const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
const uid = () => Math.random().toString(36).slice(2, 9);

function store(key: string, value: string | null): void {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {}
}
function load(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

// ---- State -------------------------------------------------------------------------------------

type Mode = "simple" | "advanced";
let mode = "simple" as Mode;
let state: SimpleState = newState();
let newChoices = 4;
/** What the preview currently shows, for print / PDF / test.json. */
let current: { pages: string[]; title: string; json: string; complete: boolean } | null = null;

const nameInput = $<HTMLInputElement>("s-name");
const typeSelect = $<HTMLSelectElement>("s-type");
const keySwitch = $<HTMLInputElement>("s-key");
const list = $("q-list");
const advText = $<HTMLTextAreaElement>("a-json");
const advStatus = $("a-status");
const twoCol = $<HTMLInputElement>("o-two-col");
const sheetSel = $<HTMLSelectElement>("o-sheet");
const status = $("status");
const pagesEl = $("pages");
const printRoot = $("print-root");

// ---- Preview -----------------------------------------------------------------------------------

let timer = 0;
function queue(): void {
    clearTimeout(timer);
    timer = window.setTimeout(refresh, 150);
}

/** The text the preview is built from, and the text a saved test.json holds. */
function sources(): { preview: string; saved: string } {
    if (mode === "advanced") {
        const text = extractJson(advText.value).text;
        return { preview: text, saved: text };
    }
    return {
        preview: JSON.stringify(toDoc(state, { placeholders: true })),
        saved: `${JSON.stringify(toDoc(state), null, 2)}\n`,
    };
}

function issueText(i: ValidationIssue): string {
    return i.where ? `${i.where}: ${i.message}` : i.message;
}

function refresh(): void {
    const { preview, saved } = sources();
    const empty = mode === "advanced" ? !advText.value.trim() : false;
    if (empty) {
        setPreview(null, "Paste or write some Test JSON to see the sheet.");
        advStatus.textContent = "";
        advStatus.className = "free-status";
        return;
    }
    const result = parseSheetJson(preview, {
        answerSheet: sheetSel.value === "separate",
        singleColumn: !twoCol.checked,
    });
    if (!result.ok) {
        const first = result.errors[0]!;
        const more = result.errors.length > 1 ? ` (and ${plural(result.errors.length - 1, "more problem")})` : "";
        status.textContent = `Can't draw the sheet yet. ${issueText(first)}${more}`;
        status.classList.add("is-error");
        pagesEl.classList.add("is-stale");
        disableOutputs();
        if (mode === "advanced") showAdvStatus(false, result.errors);
        saveDraft();
        return;
    }
    status.classList.remove("is-error");
    pagesEl.classList.remove("is-stale");
    const separate = sheetSel.value === "separate" && !result.studyGuide;
    let pages: string[];
    let answerPages = 0;
    if (separate) {
        const s = renderSeparate(result.test);
        pages = [...s.questionPages, ...(s.blankPage ? [s.blankPage] : []), ...s.answerPages.map((p) => p.svg)];
        answerPages = s.answerPages.length;
    } else {
        pages = renderTest(result.test).map((p) => p.svg);
    }
    const complete = mode === "advanced" ? true : result.studyGuide || !keySwitch.checked || missingAnswers(state).length === 0;
    current = { pages, title: result.test.title, json: saved, complete };
    drawPages(pages, answerPages);
    const n = result.test.questions.length;
    status.textContent = result.studyGuide
        ? `Study guide: ${plural(n, "question")}, ${plural(pages.length, "page")}. Nothing to fill in or grade.`
        : `${plural(n, "question")}, ${plural(pages.length, "page")} per student.${separate ? ` Only the last ${plural(answerPages, "page")} ${answerPages === 1 ? "is" : "are"} scanned.` : ""}`;
    $<HTMLButtonElement>("btn-print").disabled = false;
    $<HTMLButtonElement>("btn-pdf").disabled = false;
    $<HTMLButtonElement>("btn-json").disabled = !current.complete;
    showKeyLine(result.key, result.studyGuide, !!result.grading);
    showNotes(result.notes);
    if (mode === "advanced") showAdvStatus(true, [], `${result.sheetType}, ${plural(n, "question")}${result.grading ? ", answer key included" : ", no answer key"}.`);
    else showSimpleHints();
    saveDraft();
}

function disableOutputs(): void {
    for (const id of ["btn-print", "btn-pdf", "btn-json"]) $<HTMLButtonElement>(id).disabled = true;
}

function setPreview(c: typeof current, message: string): void {
    current = c;
    status.textContent = message;
    status.classList.remove("is-error");
    pagesEl.replaceChildren();
    printRoot.replaceChildren();
    disableOutputs();
    $("key-line").hidden = true;
    $("note").hidden = true;
}

function drawPages(pages: string[], answerPages: number): void {
    const firstAnswer = answerPages ? pages.length - answerPages : Infinity;
    pagesEl.replaceChildren(
        ...pages.map((svg, i) => {
            const fig = el("figure", "demo-page");
            const paper = el("div", "demo-paper");
            paper.innerHTML = svg;
            const kind = answerPages ? (i >= firstAnswer ? " · Answer sheet (scanned)" : " · Questions") : "";
            fig.append(paper, el("figcaption", "", `Page ${i + 1} of ${pages.length}${kind}`));
            return fig;
        }),
    );
    printRoot.replaceChildren(
        ...pages.map((svg) => {
            const page = el("div", "print-page");
            page.innerHTML = svg;
            return page;
        }),
    );
}

function showKeyLine(key: string | null, study: boolean, graded: boolean): void {
    const line = $("key-line");
    line.hidden = study || !key;
    if (key) {
        line.replaceChildren(el("strong", "", "Answer key: "), document.createTextNode(key.split(",").map((a, i) => `${i + 1}${a}`).join("  ")));
    }
    if (!key && !study && graded) {
        line.hidden = false;
        line.textContent = "This test has written answers, so it has no single-line letter key. Download test.json to keep the model answers.";
    }
}

function showNotes(notes: ValidationIssue[]): void {
    const n = $("note");
    n.hidden = notes.length === 0;
    n.textContent = notes.map(issueText).join(" ");
}

function showAdvStatus(ok: boolean, errors: ValidationIssue[], text = ""): void {
    advStatus.className = `free-status ${ok ? "is-ok" : "is-bad"}`;
    advStatus.replaceChildren();
    if (ok) {
        advStatus.textContent = `Looks good: ${text}`;
        return;
    }
    const shown = errors.slice(0, 4);
    advStatus.append(el("strong", "", errors.length === 1 ? "1 problem:" : `${errors.length} problems:`));
    const ul = el("ul");
    for (const e of shown) ul.append(el("li", "", issueText(e)));
    if (errors.length > shown.length) ul.append(el("li", "", `…and ${errors.length - shown.length} more.`));
    advStatus.append(ul);
}

/** A hint in Simple mode when answers are still missing, so "test.json" being greyed out is never a mystery. */
function showSimpleHints(): void {
    const study = state.type === "Study Guide";
    const missing = missingAnswers(state);
    const note = $("note");
    if (!study && keySwitch.checked && missing.length) {
        note.hidden = false;
        note.textContent = `Tick the correct answer on ${missing.length === 1 ? `question ${missing[0]}` : `${plural(missing.length, "more question")} (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""})`} to include the key and save test.json. The preview shows a stand-in answer meanwhile.`;
    }
}

// ---- Simple mode: the question cards -------------------------------------------------------------

function slider(label: string, value: number, min: number, max: number, onInput: (v: number) => void, unit = ""): HTMLElement {
    const id = `sl-${uid()}`;
    const wrap = el("div", "free-slider");
    const lab = el("label");
    lab.htmlFor = id;
    const out = el("output", "", `${value}${unit}`);
    lab.append(`${label}: `, out);
    const range = el("input");
    range.type = "range";
    range.id = id;
    range.min = String(min);
    range.max = String(Math.max(max, value));
    range.step = "1";
    range.value = String(value);
    range.addEventListener("input", () => {
        const v = Number(range.value);
        out.textContent = `${v}${unit}`;
        onInput(v);
    });
    wrap.append(lab, range);
    return wrap;
}

function labeled(label: string, control: HTMLElement): HTMLElement {
    const wrap = el("div", "demo-field");
    const id = `f-${uid()}`;
    const lab = el("label", "demo-label", label);
    lab.htmlFor = id;
    control.id = id;
    wrap.append(lab, control);
    return wrap;
}

function textarea(value: string, rows: number, onInput: (v: string) => void, max = 2000): HTMLTextAreaElement {
    const t = el("textarea", "form-control");
    t.rows = rows;
    t.maxLength = max;
    t.value = value;
    t.addEventListener("input", () => {
        onInput(t.value);
        queue();
    });
    return t;
}

function iconButton(text: string, label: string, onClick: () => void, disabled = false): HTMLButtonElement {
    const b = el("button", "demo-icon", text);
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
}

function card(q: SimpleQuestion, n: number): HTMLElement {
    const c = el("div", "demo-q");
    c.dataset.index = String(n);
    const head = el("div", "demo-q-head");
    head.append(el("strong", "", `${n + 1}. ${q.kind === "mc" ? "Multiple choice" : "Written answer"}`));
    const tools = el("div", "free-tools");
    tools.append(
        iconButton("↑", `Move question ${n + 1} up`, () => move(n, -1), n === 0),
        iconButton("↓", `Move question ${n + 1} down`, () => move(n, 1), n === state.questions.length - 1),
        iconButton("Copy", `Duplicate question ${n + 1}`, () => duplicate(n), state.questions.length >= MAX_SIMPLE_QUESTIONS),
        iconButton("Remove", `Remove question ${n + 1}`, () => remove(n)),
    );
    head.append(tools);
    c.append(head, labeled(q.kind === "mc" ? "Question" : "Prompt", textarea(q.prompt, 2, (v) => (q.prompt = v), 2000)));

    if (q.kind === "mc") {
        const choices = el("div", "demo-choices");
        choices.append(el("p", "free-help", "Tick the circle beside each correct answer. Tick more than one for “select all that apply”."));
        const drawChoices = () => {
            for (const row of [...choices.querySelectorAll(".demo-choice, .btn-demo-sm")]) row.remove();
            q.choices.forEach((text, i) => {
                const row = el("div", "demo-choice");
                const mark = el("button", "free-correct", letter(i));
                mark.type = "button";
                const sync = () => {
                    const on = q.correct.includes(i);
                    mark.setAttribute("aria-pressed", String(on));
                    mark.setAttribute("aria-label", `Choice ${letter(i)} is ${on ? "" : "not "}correct`);
                    mark.title = on ? "Correct answer (click to untick)" : "Click to mark as a correct answer";
                };
                sync();
                mark.addEventListener("click", () => {
                    q.correct = q.correct.includes(i) ? q.correct.filter((x) => x !== i) : [...q.correct, i];
                    sync();
                    queue();
                });
                const inp = el("input", "form-control");
                inp.type = "text";
                inp.maxLength = 500;
                inp.value = text;
                inp.setAttribute("aria-label", `Choice ${letter(i)}`);
                inp.addEventListener("input", () => {
                    q.choices[i] = inp.value;
                    queue();
                });
                const del = iconButton("×", `Remove choice ${letter(i)}`, () => {
                    q.choices.splice(i, 1);
                    q.correct = q.correct.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x));
                    drawChoices();
                    queue();
                }, q.choices.length <= MIN_CHOICES);
                row.append(mark, inp, del);
                choices.append(row);
            });
            const add = el("button", "btn-demo-sm", "+ Add choice");
            add.type = "button";
            add.disabled = q.choices.length >= MAX_CHOICES;
            add.addEventListener("click", () => {
                q.choices.push("");
                drawChoices();
                (choices.querySelectorAll<HTMLInputElement>(".demo-choice input")[q.choices.length - 1])?.focus();
                queue();
            });
            choices.append(add);
        };
        drawChoices();
        c.append(choices);
    } else {
        c.append(
            labeled("Model answer", textarea(q.model, 2, (v) => (q.model = v))),
            slider("Writing lines", q.lines ?? 3, 1, 20, (v) => {
                q.lines = v;
                queue();
            }),
            slider("Points", q.points ?? 1, 1, 20, (v) => {
                q.points = v;
                queue();
            }),
        );
        const more = el("details", "free-details");
        more.append(el("summary", "", "Rubric (optional)"), labeled("What earns each point", textarea(q.rubric, 2, (v) => (q.rubric = v))));
        c.append(more);
    }
    const why = el("details", "free-details");
    why.open = q.explanation.trim() !== "";
    why.append(el("summary", "", "Explanation (optional)"), labeled("Why the answer is right", textarea(q.explanation, 2, (v) => (q.explanation = v))));
    c.append(why);
    return c;
}

function build(focusIndex?: number, scroll = false): void {
    list.replaceChildren(...state.questions.map(card));
    if (!state.questions.length) list.append(el("p", "demo-empty", "No questions yet. Add one below."));
    const full = state.questions.length >= MAX_SIMPLE_QUESTIONS;
    $<HTMLButtonElement>("add-mc").disabled = $<HTMLButtonElement>("add-free").disabled = full;
    $("s-limit").hidden = !full;
    $("s-extras").hidden = !hasExtras(state);
    if (focusIndex !== undefined) {
        const target = list.children[focusIndex] as HTMLElement | undefined;
        target?.querySelector<HTMLElement>("textarea")?.focus({ preventScroll: !scroll });
        if (scroll) target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
}

function move(i: number, d: number): void {
    const j = i + d;
    if (j < 0 || j >= state.questions.length) return;
    const [q] = state.questions.splice(i, 1);
    state.questions.splice(j, 0, q!);
    build();
    (list.children[j]?.querySelectorAll<HTMLButtonElement>(".free-tools button")[d < 0 ? 0 : 1])?.focus();
    queue();
}
function duplicate(i: number): void {
    if (state.questions.length >= MAX_SIMPLE_QUESTIONS) return;
    state.questions.splice(i + 1, 0, structuredClone(state.questions[i]!));
    build(i + 1, true);
    queue();
}
function remove(i: number): void {
    state.questions.splice(i, 1);
    build();
    queue();
}
function add(kind: "mc" | "free"): void {
    if (state.questions.length >= MAX_SIMPLE_QUESTIONS) return;
    state.questions.push(newQuestion(kind, newChoices));
    build(state.questions.length - 1, true);
    queue();
}

/** Writes the whole state into the form controls (after a load or a switch from Advanced). */
function syncForm(): void {
    nameInput.value = state.name;
    typeSelect.value = state.type;
    keySwitch.checked = state.key;
    $("s-key-field").hidden = state.type === "Study Guide";
    build();
}

// ---- Switching modes -----------------------------------------------------------------------------

function setMode(next: Mode, quiet = false): boolean {
    if (next === mode && !quiet) return true;
    if (next === "advanced") {
        advText.value = `${JSON.stringify(toDoc(state), null, 2)}\n`;
        mode = "advanced";
    } else {
        // Advanced -> Simple: only when the JSON is a valid test, so nothing is silently lost.
        const text = extractJson(advText.value).text;
        if (text.trim()) {
            const r = parseSheetJson(text, { layout: false });
            let doc: unknown = null;
            try {
                doc = JSON.parse(text);
            } catch {}
            const imported = r.ok ? importDoc(doc) : null;
            if (!imported) {
                const msg = r.ok ? "That JSON can't be shown in Simple mode." : `Fix this first: ${issueText(r.errors[0]!)}`;
                advStatus.className = "free-status is-bad";
                advStatus.textContent = `Staying in Advanced mode. ${msg}`;
                return false;
            }
            state = imported;
            twoCol.checked = (doc as { columns?: unknown }).columns !== 1;
        }
        mode = "simple";
        syncForm();
    }
    $("panel-simple").hidden = mode !== "simple";
    $("panel-advanced").hidden = mode !== "advanced";
    $("mode-simple").setAttribute("aria-pressed", String(mode === "simple"));
    $("mode-advanced").setAttribute("aria-pressed", String(mode === "advanced"));
    $("mode-hint").textContent =
        mode === "simple" ? "Fill in the boxes. We write the Test JSON for you." : "Write or paste Test JSON. It is checked as you type.";
    $("note").hidden = true;
    refresh();
    return true;
}

// ---- Advanced mode ---------------------------------------------------------------------------------

function setJson(text: string): void {
    advText.value = text;
    refresh();
}

function onAdvInput(): void {
    queue();
}

function tidy(): void {
    const { text, cleaned } = extractJson(advText.value);
    if (cleaned) {
        advText.value = text;
        refresh();
    }
}

// ---- AI prompt helper ----------------------------------------------------------------------------------

function aiPrompt(): string {
    return buildPrompt({
        ...DEFAULTS,
        topic: $<HTMLInputElement>("ai-topic").value,
        audience: $<HTMLInputElement>("ai-audience").value,
        kind: $<HTMLSelectElement>("ai-kind").value as Kind,
        style: $<HTMLSelectElement>("ai-style").value as Style,
        count: Number($<HTMLInputElement>("ai-count").value),
    });
}
function syncAi(): void {
    $<HTMLTextAreaElement>("ai-prompt").value = aiPrompt();
}

// ---- Output ------------------------------------------------------------------------------------------------

function slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "sheet";
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

async function downloadPdf(): Promise<void> {
    if (!current) return;
    const btn = $<HTMLButtonElement>("btn-pdf");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Building PDF…";
    try {
        const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
        doc.setProperties({ title: current.title, creator: "Grade Lake" });
        for (const [i, page] of current.pages.entries()) {
            if (i > 0) doc.addPage("letter", "portrait");
            const svg = new DOMParser().parseFromString(page, "image/svg+xml").documentElement;
            await doc.svg(svg, { x: 0, y: 0, width: LETTER_PT.w, height: LETTER_PT.h });
        }
        download(`${slug(current.title)}.pdf`, doc.output("blob"));
    } catch (e) {
        status.textContent = `Couldn't build the PDF: ${e instanceof Error ? e.message : String(e)}`;
        status.classList.add("is-error");
    } finally {
        btn.disabled = false;
        btn.textContent = label;
    }
}

function continueInGradeLake(): void {
    const { saved } = sources();
    store(HANDOFF_KEY, saved);
    location.href = "/register";
}

// ---- Draft ---------------------------------------------------------------------------------------------------

function saveDraft(): void {
    store(
        DRAFT_KEY,
        JSON.stringify({
            mode,
            json: mode === "advanced" ? advText.value : JSON.stringify(toDoc(state)),
            key: keySwitch.checked,
            twoCol: twoCol.checked,
            sheet: sheetSel.value,
        }),
    );
}

function restoreDraft(): boolean {
    const raw = load(DRAFT_KEY);
    if (!raw) return false;
    try {
        const d = JSON.parse(raw) as { mode: Mode; json: string; key: boolean; twoCol: boolean; sheet: string };
        twoCol.checked = d.twoCol !== false;
        sheetSel.value = d.sheet === "separate" ? "separate" : "inline";
        if (d.mode === "advanced") {
            advText.value = d.json;
            mode = "advanced";
        } else {
            const s = importDoc(JSON.parse(d.json));
            if (!s) return false;
            s.key = s.type === "Study Guide" ? true : d.key !== false;
            state = s;
        }
        return true;
    } catch {
        return false;
    }
}

// ---- Wiring ------------------------------------------------------------------------------------------------------

nameInput.addEventListener("input", () => {
    state.name = nameInput.value;
    queue();
});
typeSelect.addEventListener("change", () => {
    state.type = typeSelect.value as SheetKind;
    $("s-key-field").hidden = state.type === "Study Guide";
    queue();
});
keySwitch.addEventListener("change", () => {
    state.key = keySwitch.checked;
    queue();
});
$("add-mc").addEventListener("click", () => add("mc"));
$("add-free").addEventListener("click", () => add("free"));
$<HTMLInputElement>("s-newchoices").addEventListener("input", (e) => {
    newChoices = Number((e.target as HTMLInputElement).value);
    $("s-newchoices-out").textContent = String(newChoices);
});
$("mode-simple").addEventListener("click", () => setMode("simple"));
$("mode-advanced").addEventListener("click", () => setMode("advanced"));
twoCol.addEventListener("change", queue);
sheetSel.addEventListener("change", queue);

advText.addEventListener("input", onAdvInput);
advText.addEventListener("paste", () => setTimeout(tidy, 0));
advText.addEventListener("blur", tidy);
$("a-example").addEventListener("click", () => setJson(MINI_EXAMPLE));
$("a-example-fig").addEventListener("click", () => setJson(`${JSON.stringify(figuresExample, null, 2)}\n`));
$("a-clear").addEventListener("click", () => {
    setJson("");
    advText.focus();
});
$("a-load").addEventListener("click", () => $<HTMLInputElement>("a-file").click());
$<HTMLInputElement>("a-file").addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) setJson(await file.text());
    input.value = "";
});
for (const ev of ["dragover", "drop"] as const) {
    advText.addEventListener(ev, async (e) => {
        e.preventDefault();
        if (ev === "drop") {
            const file = (e as DragEvent).dataTransfer?.files[0];
            if (file) setJson(await file.text());
        }
    });
}

for (const id of ["ai-topic", "ai-audience", "ai-kind", "ai-style", "ai-count"]) {
    $(id).addEventListener("input", syncAi);
    $(id).addEventListener("change", syncAi);
}
async function copyPrompt(open?: string): Promise<void> {
    syncAi();
    const ok = await copyText($<HTMLTextAreaElement>("ai-prompt").value);
    const b = $("ai-copy");
    b.textContent = ok ? "Copied!" : "Copy failed: select the text and copy it";
    setTimeout(() => (b.textContent = "Copy prompt"), 2000);
    if (ok && open) window.open(open, "_blank", "noopener,noreferrer");
}
$("ai-copy").addEventListener("click", () => void copyPrompt());
for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-ai-open]")) {
    a.addEventListener("click", (e) => {
        e.preventDefault();
        void copyPrompt(a.href);
    });
}

$("btn-print").addEventListener("click", () => window.print());
$("btn-pdf").addEventListener("click", () => void downloadPdf());
$("btn-json").addEventListener("click", () => {
    if (current?.complete) download("test.json", new Blob([current.json], { type: "application/json" }));
});
$("btn-continue").addEventListener("click", continueInGradeLake);

// ---- Start -----------------------------------------------------------------------------------------------------------

if (!restoreDraft()) {
    state = newState();
    state.name = "Unit 1 Quiz";
    state.questions[0]!.prompt = "Which of these is a prime number?";
    state.questions[0]!.choices = ["9", "15", "17", "21"];
    state.questions[0]!.correct = [2];
    state.questions[1]!.prompt = "What is 12 x 8?";
    state.questions[1]!.choices = ["84", "96", "108", "112"];
    state.questions[1]!.correct = [1];
}
syncForm();
syncAi();
if (mode === "advanced") {
    $("panel-simple").hidden = true;
    $("panel-advanced").hidden = false;
    $("mode-simple").setAttribute("aria-pressed", "false");
    $("mode-advanced").setAttribute("aria-pressed", "true");
    $("mode-hint").textContent = "Write or paste Test JSON. It is checked as you type.";
}
refresh();
