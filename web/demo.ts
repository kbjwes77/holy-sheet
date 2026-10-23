// Landing page live demo: a small editable quiz rendered by the real Sheet Generator code, in the browser.
import { renderSeparate } from "../gen/booklet.ts";
import { renderTest } from "../gen/sheet.ts";
import { parseSheetJson } from "../gen/testdef.ts";

const MAX_QUESTIONS = 6;
const MAX_CHOICES = 6;
const MIN_CHOICES = 2;

type FigureId = "" | "graph" | "table";
type Mode = "none" | "inline" | "separate";
interface Question {
    type: "mc" | "frq";
    prompt: string;
    choices: string[];
    figure: FigureId;
}

const FIGURES = {
    graph: {
        type: "svg",
        width: 2.4,
        caption: "Figure 1: The market for notebooks",
        content:
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 200"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#000"/></marker></defs>' +
            '<line x1="40" y1="180" x2="40" y2="10" stroke="#000" stroke-width="1.5" marker-end="url(#arrow)"/><line x1="40" y1="180" x2="250" y2="180" stroke="#000" stroke-width="1.5" marker-end="url(#arrow)"/>' +
            '<text x="14" y="20" font-size="11">P</text><text x="222" y="196" font-size="11">Q</text>' +
            '<line x1="60" y1="40" x2="220" y2="160" stroke="#000" stroke-width="2"/><text x="222" y="158" font-size="11">D</text>' +
            '<line x1="60" y1="160" x2="220" y2="40" stroke="#000" stroke-width="2"/><text x="222" y="40" font-size="11">S</text>' +
            '<line x1="40" y1="100" x2="140" y2="100" stroke="#000" stroke-dasharray="4 3"/><line x1="140" y1="100" x2="140" y2="180" stroke="#000" stroke-dasharray="4 3"/>' +
            '<text x="12" y="104" font-size="11">P<tspan font-size="8" dy="3">e</tspan></text><text x="134" y="194" font-size="11">Q<tspan font-size="8" dy="3">e</tspan></text></svg>',
    },
    table: {
        type: "table",
        caption: "Figure 2: Demand and supply schedule",
        content:
            "<table><thead><tr><th>Price</th><th>Quantity demanded</th><th>Quantity supplied</th></tr></thead><tbody>" +
            "<tr><td>$2</td><td>80</td><td>20</td></tr><tr><td>$4</td><td>60</td><td>40</td></tr><tr><td>$6</td><td>40</td><td>60</td></tr><tr><td>$8</td><td>20</td><td>80</td></tr></tbody></table>",
    },
} as const;

const FIGURE_LABELS: Record<FigureId, string> = { "": "None", graph: "Supply and demand graph", table: "Price schedule table" };

const MC_STARTERS = [
    ["Using the graph, what happens to the equilibrium price if demand increases?", ["It rises", "It falls", "It stays the same", "It cannot be determined"], "graph"],
    ["Which of the following would shift the supply curve to the right?", ["A fall in input prices", "A rise in consumer income", "A new tax on producers", "A change in tastes"], ""],
    ["A price floor set above equilibrium creates which of the following?", ["A surplus", "A shortage", "No change", "A lower price"], ""],
] as const;
const FRQ_STARTERS = [
    ["Use the table to find the equilibrium price and explain how you know.", "table"],
    ["Explain why a price ceiling set below the equilibrium price creates a shortage.", ""],
    ["Describe how a rise in input costs changes the market for notebooks.", ""],
] as const;

const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
}

export function initDemo(root: HTMLElement): void {
    const list = $<HTMLElement>(root, "[data-list]");
    const addMc = $<HTMLButtonElement>(root, "[data-add-mc]");
    const addFrq = $<HTMLButtonElement>(root, "[data-add-frq]");
    const twoCol = $<HTMLInputElement>(root, "[data-two-col]");
    const modeSel = $<HTMLSelectElement>(root, "[data-mode]");
    const pages = $<HTMLElement>(root, "[data-pages]");
    const status = $<HTMLElement>(root, "[data-status]");
    const hint = $<HTMLElement>(root, "[data-limit]");

    const questions: Question[] = [
        { type: "mc", prompt: MC_STARTERS[0][0], choices: [...MC_STARTERS[0][1]], figure: MC_STARTERS[0][2] },
        { type: "frq", prompt: FRQ_STARTERS[0][0], choices: [], figure: FRQ_STARTERS[0][1] },
    ];
    let mcAdded = 1;
    let frqAdded = 1;
    let timer = 0;

    const queue = () => {
        clearTimeout(timer);
        timer = window.setTimeout(render, 120);
    };

    function figureSelect(q: Question): HTMLElement {
        const wrap = el("div", "demo-field");
        const id = `demo-fig-${Math.random().toString(36).slice(2, 8)}`;
        const label = el("label", "demo-label", "Figure");
        label.htmlFor = id;
        const sel = el("select", "form-select");
        sel.id = id;
        for (const k of ["", "graph", "table"] as const) sel.append(new Option(FIGURE_LABELS[k], k, false, q.figure === k));
        sel.addEventListener("change", () => {
            q.figure = sel.value as FigureId;
            queue();
        });
        wrap.append(label, sel);
        return wrap;
    }

    function card(q: Question, n: number): HTMLElement {
        const c = el("div", "demo-q");
        const head = el("div", "demo-q-head");
        head.append(el("strong", "", `${n + 1}. ${q.type === "mc" ? "Multiple choice" : "Free response"}`));
        const rm = el("button", "demo-icon", "Remove");
        rm.type = "button";
        rm.setAttribute("aria-label", `Remove question ${n + 1}`);
        rm.addEventListener("click", () => {
            questions.splice(questions.indexOf(q), 1);
            build();
            queue();
        });
        head.append(rm);

        const pid = `demo-p-${Math.random().toString(36).slice(2, 8)}`;
        const plabel = el("label", "demo-label", q.type === "mc" ? "Question" : "FRQ prompt");
        plabel.htmlFor = pid;
        const prompt = el("textarea", "form-control");
        prompt.id = pid;
        prompt.rows = 2;
        prompt.maxLength = 300;
        prompt.value = q.prompt;
        prompt.addEventListener("input", () => {
            q.prompt = prompt.value;
            queue();
        });
        c.append(head, plabel, prompt);

        if (q.type === "mc") {
            const cl = el("div", "demo-choices");
            const draw = () => {
                cl.replaceChildren();
                q.choices.forEach((text, i) => {
                    const row = el("div", "demo-choice");
                    row.append(el("span", "demo-letter", String.fromCharCode(65 + i)));
                    const inp = el("input", "form-control");
                    inp.type = "text";
                    inp.maxLength = 120;
                    inp.value = text;
                    inp.setAttribute("aria-label", `Choice ${String.fromCharCode(65 + i)}`);
                    inp.addEventListener("input", () => {
                        q.choices[i] = inp.value;
                        queue();
                    });
                    const del = el("button", "demo-icon", "×");
                    del.type = "button";
                    del.title = "Remove choice";
                    del.setAttribute("aria-label", `Remove choice ${String.fromCharCode(65 + i)}`);
                    del.disabled = q.choices.length <= MIN_CHOICES;
                    del.addEventListener("click", () => {
                        q.choices.splice(i, 1);
                        draw();
                        queue();
                    });
                    row.append(inp, del);
                    cl.append(row);
                });
                const add = el("button", "btn-demo-sm", "+ Add choice");
                add.type = "button";
                add.disabled = q.choices.length >= MAX_CHOICES;
                add.addEventListener("click", () => {
                    q.choices.push(`Choice ${String.fromCharCode(65 + q.choices.length)}`);
                    draw();
                    queue();
                });
                cl.append(add);
            };
            draw();
            c.append(cl);
        }
        c.append(figureSelect(q));
        return c;
    }

    function build(): void {
        list.replaceChildren(...questions.map(card));
        if (!questions.length) list.append(el("p", "demo-empty", "No questions yet. Add one below."));
        const full = questions.length >= MAX_QUESTIONS;
        addMc.disabled = addFrq.disabled = full;
        hint.hidden = !full;
    }

    function toJson(mode: Mode): string {
        const used = new Set<string>();
        const qs = questions.map((q) => {
            const out: Record<string, unknown> = { prompt: q.prompt.trim() };
            if (q.figure) {
                out.figures = [q.figure];
                used.add(q.figure);
            }
            if (mode !== "none") {
                if (q.type === "mc") Object.assign(out, { choices: q.choices.map((s) => s.trim()), answer: "A" });
                else Object.assign(out, { type: "Free Response", answer: "Sample answer", lines: 3 });
            }
            return out;
        });
        return JSON.stringify({
            test: "Supply and Demand Quiz",
            questions: qs,
            figures: Object.fromEntries([...used].map((k) => [k, FIGURES[k as "graph" | "table"]])),
            ...(twoCol.checked ? {} : { columns: 1 }),
        });
    }

    function render(): void {
        pages.replaceChildren();
        if (!questions.length) {
            status.textContent = "Add a question to see its sheet.";
            return;
        }
        const mode = modeSel.value as Mode;
        const result = parseSheetJson(toJson(mode), { answerSheet: mode === "separate" });
        if (!result.ok) {
            const first = result.errors[0]!;
            status.textContent = `${first.where}: ${first.message}`;
            return;
        }
        let svgs: string[];
        let firstAnswer = Infinity;
        if (mode === "separate") {
            const s = renderSeparate(result.test);
            svgs = [...s.questionPages, ...(s.blankPage ? [s.blankPage] : []), ...s.answerPages.map((p) => p.svg)];
            firstAnswer = svgs.length - s.answerPages.length;
        } else {
            svgs = renderTest(result.test).map((p) => p.svg);
        }
        status.textContent =
            mode === "none"
                ? `Study guide, ${svgs.length} page${svgs.length === 1 ? "" : "s"}. Nothing to fill in or grade.`
                : mode === "inline"
                  ? `${svgs.length} page${svgs.length === 1 ? "" : "s"}. Students fill in the bubbles beside each question, and you scan the stack.`
                  : `${svgs.length} pages. Questions stay on plain pages; only the final answer sheet is scanned.`;
        pages.replaceChildren(
            ...svgs.map((svg, i) => {
                const fig = el("figure", "demo-page");
                const paper = el("div", "demo-paper");
                paper.innerHTML = svg;
                const kind = mode === "separate" ? (i >= firstAnswer ? " · Answer sheet" : " · Questions") : "";
                fig.append(paper, el("figcaption", "", `Page ${i + 1} of ${svgs.length}${kind}`));
                return fig;
            }),
        );
    }

    addMc.addEventListener("click", () => {
        const s = MC_STARTERS[mcAdded++ % MC_STARTERS.length]!;
        questions.push({ type: "mc", prompt: s[0], choices: [...s[1]], figure: s[2] });
        build();
        queue();
        list.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    addFrq.addEventListener("click", () => {
        const s = FRQ_STARTERS[frqAdded++ % FRQ_STARTERS.length]!;
        questions.push({ type: "frq", prompt: s[0], choices: [], figure: s[1] });
        build();
        queue();
        list.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    twoCol.addEventListener("change", queue);
    modeSel.addEventListener("change", queue);

    build();
    render();
}
