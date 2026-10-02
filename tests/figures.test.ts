import { describe, expect, test } from "bun:test";
import { prepareFigure, type Figure, type FigureDef } from "../gen/figures.ts";
import { figureMaxWidth, paginate, renderTest } from "../gen/sheet.ts";
import { parseSheetJson } from "../gen/testdef.ts";
import { parseXml, XmlError } from "../gen/xml.ts";
import { LAYOUT, colX, rowY, textRightEdge } from "../src/layout.ts";

const MAX = figureMaxWidth();
const svg = (body: string, attrs = `viewBox="0 0 200 100"`) => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const prep = (def: Partial<FigureDef> & { content: string }, id = "f") => prepareFigure(id, { type: "svg", ...def } as FigureDef, MAX);
const ok = (r: ReturnType<typeof prep>): Figure => {
    if (!r.ok) throw new Error(r.errors.join("\n"));
    return r.figure;
};
const errorsOf = (r: ReturnType<typeof prep>) => (r.ok ? [] : r.errors).join("\n");

describe("xml parser", () => {
    test("elements, attributes, entities, comments and CDATA", () => {
        const el = parseXml(`<?xml version="1.0"?><!-- c --><!DOCTYPE svg><a x='1' y="&lt;&#65;&#x42;">t &amp; u<b/><![CDATA[<raw>]]></a>`);
        expect(el.name).toBe("a");
        expect(el.attrs).toEqual([
            ["x", "1"],
            ["y", "<AB"],
        ]);
        expect(el.children.map((n) => (n.kind === "text" ? n.text : `<${n.name}>`))).toEqual(["t & u", "<b>", "<raw>"]);
    });

    test("malformed markup is an error with a line number", () => {
        expect(() => parseXml("<a>\n<b></a>")).toThrow(/<\/a> closes <b> \(from line 2\).*line 2/);
        expect(() => parseXml("<a x=1/>")).toThrow(/must be in quotes/);
        expect(() => parseXml("<a>&nbsp;</a>")).toThrow(/unknown entity/);
        expect(() => parseXml("<a>AT&T</a>")).toThrow(XmlError);
        expect(() => parseXml("<a/><b/>")).toThrow(/second top-level/);
        expect(() => parseXml("<a>")).toThrow(/never closed/);
    });

    test("HTML mode: case-insensitive names and HTML entities", () => {
        const el = parseXml(`<TABLE><TR><TD>5&nbsp;&ndash;&nbsp;6</TD></TR></TABLE>`, { html: true });
        expect(el.name).toBe("table");
        const td = (el.children[0] as any).children[0];
        expect(td.name).toBe("td");
        expect(td.children[0].text).toBe("5 – 6");
    });
});

describe("svg figures", () => {
    test("natural size at 96 px per inch, a requested width, and scaling down to the column", () => {
        expect(ok(prep({ content: svg("", `width="192" height="96"`) }))).toMatchObject({ w: 200, h: 100 });
        expect(ok(prep({ content: svg("", `width="2in" height="1in"`) }))).toMatchObject({ w: 200, h: 100 });
        expect(ok(prep({ content: svg("", `viewBox="0 0 96 48"`), width: 3 }))).toMatchObject({ w: 300, h: 150 });
        const wide = ok(prep({ content: svg("", `viewBox="0 0 2000 500"`) }));
        expect(wide.w).toBeCloseTo(MAX);
        expect(wide.h).toBeCloseTo(MAX / 4);
        expect(errorsOf(prep({ content: svg(""), width: 9 }))).toMatch(/"width" is 9 in, wider than the text column/);
        expect(errorsOf(prep({ content: svg("", `width="50%" height="20"`) }))).toMatch(/not %/);
        expect(errorsOf(prep({ content: svg("", "") }))).toMatch(/needs a viewBox/);
    });

    test("viewBox maps into the box with preserveAspectRatio", () => {
        const draw = (attrs: string) => ok(prep({ content: svg("<rect/>", attrs) })).draw("x-");
        expect(draw(`width="200" height="100" viewBox="10 20 100 100"`)).toContain(`transform="translate(52.08 0) scale(1.04167 1.04167) translate(-10 -20)"`);
        expect(draw(`width="200" height="100" viewBox="0 0 100 100" preserveAspectRatio="xMinYMin meet"`)).toContain("translate(0 0) scale(1.04167 1.04167)");
        expect(draw(`width="200" height="100" viewBox="0 0 100 100" preserveAspectRatio="none"`)).toContain("scale(2.08333 1.04167)");
    });

    test("ids and references get the placement prefix; output is clipped to the box", () => {
        const fig = ok(
            prep({
                content: svg(
                    `<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient><marker id="m"><path d="M0 0"/></marker><path id="p" d="M0 0"/></defs>` +
                        `<rect fill="url(#g)" style="stroke: url('#g'); stroke-width: 2"/><line marker-end="url(#m)"/><use xlink:href="#p"/><use href="#p"/>`,
                ),
            }),
        );
        const out = fig.draw("p1f2-");
        expect(out).toContain(`<clipPath id="p1f2-box">`);
        expect(out).toContain(`clip-path="url(#p1f2-box)"`);
        expect(out).toContain(`<linearGradient id="p1f2-g">`);
        expect(out).toContain(`fill="url(#p1f2-g)"`);
        expect(out).toContain(`stroke="url(#p1f2-g)"`);
        expect(out).toContain(`stroke-width="2"`);
        expect(out).toContain(`marker-end="url(#p1f2-m)"`);
        expect(out.match(/xlink:href="#p1f2-p"/g)).toHaveLength(2);
        expect(out).toContain(`font-family="Arial, Helvetica, sans-serif"`);
    });

    test("metadata and editor attributes are dropped quietly", () => {
        const out = ok(
            prep({
                content: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="x" version="1.1" viewBox="0 0 10 10" inkscape:version="1"><title>t</title><metadata>m</metadata><sodipodi:namedview/><path d="M0 0" inkscape:label="a" data-x="1" style="isolation:isolate;fill:#f00"/></svg>`,
            }),
        ).draw("");
        expect(out).toContain(`<path d="M0 0" fill="#f00"></path>`);
        expect(out).not.toMatch(/inkscape|title|metadata|data-x|isolation/);
    });

    test("anything that wouldn't print as previewed is an error", () => {
        const errs = errorsOf(
            prep({
                content: svg(
                    `<script>alert(1)</script><style>.a{fill:red}</style><rect class="a" onclick="x()"/><image href="a.png"/><foreignObject/>` +
                        `<path fill="url(http://x/y#z)" filter="url(#f)"/><text font-family="Comic Sans MS">→</text><use href="#missing"/><rect style="font: 12px Arial"/>`,
                ),
            }),
        );
        for (const m of [
            /scripts aren't allowed/,
            /<style> blocks aren't supported/,
            /"class" isn't supported/,
            /event handlers \(onclick\)/,
            /images aren't supported/,
            /foreignObject/,
            /only references inside the figure/,
            /attribute "filter" isn't supported/,
            /font "comic sans ms"/,
            /"→" \(U\+2192\)/,
            /refers to "#missing"/,
        ])
            expect(errs).toMatch(m);
        // At most 12 problems are listed.
        expect(errs.split("\n").length).toBeLessThanOrEqual(13);
        expect(errorsOf(prep({ content: "<div/>" }))).toMatch(/must be one <svg> element/);
        expect(errorsOf(prep({ content: "<svg" }))).toMatch(/Can't read the SVG/);
    });

    test("a caption wraps under the figure and widens a narrow figure's box", () => {
        const fig = ok(prep({ content: svg("", `width="48" height="48"`), caption: "Figure 1: A rather long caption that has to wrap onto a second line" }));
        expect(fig.w).toBe(50);
        expect(fig.boxW).toBe(200);
        expect(fig.captionLines.length).toBe(2);
        expect(fig.boxH).toBeGreaterThan(fig.h + 2 * 11);
    });
});

describe("table figures", () => {
    const table = (content: string, extra: Partial<FigureDef> = {}) => prepareFigure("t", { type: "table", content, ...extra }, MAX);

    test("spans, header shading, alignment and inline styles", () => {
        const fig = ok(
            table(
                `<table border="1"><caption>Yields</caption><thead><tr><th rowspan="2">Maturity</th><th colspan="2">Yield</th></tr><tr><th>2024</th><th>2025</th></tr></thead>` +
                    `<tbody><tr><td>r<sub>real</sub> <b>now</b></td><td>4.3</td><td align="center">x</td></tr><tr><td style="text-align: right">$1,050</td><td>(2.5%)</td><td><i>n/a</i> <sup>2</sup></td></tr></tbody></table>`,
            ),
        );
        const out = fig.draw("");
        // Caption row + 4 rows of 17.5 units.
        expect(fig.h).toBeCloseTo(5 * 17.5);
        expect(out.match(/<rect /g)).toHaveLength(10);
        expect(out.match(/fill="#e6e6e6"/g)).toHaveLength(4);
        // "Maturity" spans two rows: its rect is 35 tall.
        expect(out).toMatch(/<rect x="0" y="17.5" width="[\d.]+" height="35" fill="#e6e6e6"/);
        expect(out).toContain(`font-size="7">real</text>`);
        expect(out).toContain(`font-weight="bold">now</text>`);
        expect(out).toContain(`font-style="italic">n/a</text>`);
        // Numbers are right-aligned: "4.3" ends 5 units before its column's right edge.
        const num = /<rect x="([\d.]+)" y="52.5" width="([\d.]+)"[^>]*\/><text x="([\d.]+)"[^>]*>4\.3</.exec(out)!;
        expect(Number(num[3]) + 13.9).toBeCloseTo(Number(num[1]) + Number(num[2]) - 5, 0);
    });

    test("a requested width stretches the columns; a narrower one scales the table down", () => {
        const t = `<table><tr><td>a</td><td>bb</td></tr></table>`;
        const natural = ok(table(t));
        const wide = ok(table(t, { width: 4 }));
        expect(wide.w).toBeCloseTo(400);
        expect(wide.draw("")).not.toContain("scale(");
        const narrow = ok(table(t, { width: natural.w / 200 }));
        expect(narrow.w).toBeCloseTo(natural.w / 2);
        expect(narrow.draw("")).toContain("scale(0.5)");
    });

    test("unsupported markup is an error", () => {
        const errs = (c: string) => (table(c) as { errors?: string[] }).errors?.join("\n") ?? "";
        expect(errs(`<table><tr><td>a<br/>b</td></tr></table>`)).toMatch(/<br> isn't supported/);
        expect(errs(`<table><tr><td class="x">a</td></tr></table>`)).toMatch(/attribute "class" isn't supported/);
        expect(errs(`<table><tr><td style="color: red">a</td></tr></table>`)).toMatch(/only text-align/);
        expect(errs(`<table><tr><td colspan="0">a</td></tr></table>`)).toMatch(/whole number/);
        expect(errs(`<table><tfoot></tfoot></table>`)).toMatch(/isn't supported in a table/);
        expect(errs(`<table>loose<tr><td>a</td></tr></table>`)).toMatch(/must be inside a <td>/);
        expect(errs(`<table><tr><td><span>a</span></td></tr></table>`)).toMatch(/isn't supported inside a cell/);
        expect(errs(`<table><tr><td>a</td></table>`)).toMatch(/Can't read the table/);
        expect(errs(`<div></div>`)).toMatch(/one <table> element/);
    });
});

describe("placing figures", () => {
    const fig = (w: number, h: number, id = "f"): Figure => ok(prep({ content: svg("", `width="${w * 0.96}" height="${h * 0.96}"`) }, id));
    const q = (figures: Figure[], choices = ["a", "b", "c"]) => ({ prompt: "Look at the figure.", choices, figures });

    test("figures take whole rows between the prompt and the first choice", () => {
        // Wider than a column, so it can't go beside the text.
        const [page] = paginate({ title: "T", questions: [q([fig(400, 100)])] });
        const pq = page!.questions[0]!;
        const pf = pq.figures[0]!;
        expect(pf.x).toBe(colX(LAYOUT.promptCol));
        expect(pf.y).toBeGreaterThan(rowY(pq.promptRow + pq.promptLines.length));
        // No bubble row overlaps the figure.
        expect(rowY(pq.choices[0]!.row)).toBeGreaterThanOrEqual(pf.y + 100);
        expect(pq.choices[0]!.row).toBe(pq.promptRow + 1 + Math.ceil((100 + 8) / LAYOUT.cellH));
    });

    test("side by side while they fit, then a new line", () => {
        const [page] = paginate({ title: "T", questions: [q([fig(300, 50), fig(300, 80), fig(300, 50)])] });
        const [a, b, c] = page!.questions[0]!.figures;
        expect(b!.y).toBe(a!.y);
        expect(b!.x).toBe(a!.x + 300 + 15);
        expect(c!.x).toBe(a!.x);
        expect(c!.y).toBeGreaterThanOrEqual(a!.y + 80);
    });

    test("beside the QR, a figure too wide for the space moves down to row 10", () => {
        const narrowSpace = textRightEdge(LAYOUT.qrClearRow - 1) - colX(LAYOUT.promptCol);
        const make = (w: number) => {
            const p = paginate({ title: "T", questions: [...Array.from({ length: 14 }, () => ({ prompt: "Filler", choices: ["a", "b"] })), q([fig(w, 30)])] });
            return p.at(-1)!.questions.at(-1)!;
        };
        // A figure that fits beside the QR: the prompt starts on the top row, the figure under it.
        const small = make(narrowSpace - 20);
        expect(small.promptRow).toBe(LAYOUT.topRowContinued);
        expect(small.figures[0]!.y).toBe(rowY(LAYOUT.topRowContinued + 1) + 4);
        // One that doesn't drops to row 10; rising wouldn't end the question sooner, so the prompt
        // stays as low as it can go.
        const big = make(narrowSpace + 50);
        expect(big.promptRow).toBe(LAYOUT.firstRowContinued);
        expect(big.figures[0]!.y).toBe(rowY(LAYOUT.qrClearRow) + 4);
    });

    test("a figure wider than a column prints its question full width; a narrower one can go in a column", () => {
        const column = colX(LAYOUT.columns.leftLastCol + 1) - colX(LAYOUT.promptCol);
        const [narrow] = paginate({ title: "T", questions: [q([fig(column - 10, 60)]), q([fig(column - 10, 60)])] });
        expect(narrow!.questions.map((pq) => pq.column)).toEqual(["left", "right"]);
        const right = narrow!.questions[1]!;
        expect(right.figures[0]!.x).toBe(colX(LAYOUT.columns.right.promptCol));
        const [wide] = paginate({ title: "T", questions: [q([fig(column + 10, 60)]), q([fig(column - 10, 60)]), q([fig(column - 10, 60)])] });
        expect(wide!.questions.map((pq) => pq.column)).toEqual(["full", "left", "right"]);
    });

    test("a full-width question prints column-sized figures beside its text when that's shorter", () => {
        const long = ["The price level rises and real GDP falls in the short run, then recovers", "The price level falls and real GDP rises in the short run, then levels", "Both fall", "Both rise"];
        const g = fig(250, 200);
        const [page] = paginate({ title: "T", questions: [q([g], long), q([g], long)] });
        for (const pq of page!.questions) {
            expect(pq.column).toBe("full");
            // Choices follow the prompt, each on one line; the figure is flush right, level with the prompt.
            expect(pq.choices[0]!.row).toBe(pq.promptRow + pq.promptLines.length);
            expect(pq.choices.every((c) => c.lines.length === 1)).toBe(true);
            expect(pq.figures[0]!.x + g.boxW).toBeCloseTo(textRightEdge(LAYOUT.qrClearRow));
        }
        // Page 1's questions start below the QR, so each figure starts level with its prompt.
        const [a, b] = page!.questions;
        expect(a!.promptRow).toBe(LAYOUT.firstRowPage1);
        expect(LAYOUT.firstRowPage1).toBeGreaterThanOrEqual(LAYOUT.qrClearRow);
        expect(a!.figures[0]!.y).toBe(rowY(a!.promptRow) + 4);
        expect(b!.figures[0]!.y).toBe(rowY(b!.promptRow) + 4);
        // The second question starts a blank row after the first one's figure.
        expect(b!.promptRow).toBe(LAYOUT.firstRowPage1 + Math.ceil((g.boxH + 8) / LAYOUT.cellH) + 1);
    });

    test("figures stay between prompt and choices when beside isn't shorter, a choice would wrap, or a figure is too wide", () => {
        const long = ["The price level rises and real GDP falls in the short run, then recovers", "The price level falls and real GDP rises in the short run, then levels"];
        const stacked = (pq: { figures: { y: number }[]; choices: { row: number }[] }) => pq.figures[0]!.y < rowY(pq.choices[0]!.row);
        // At the top of page 2 the figure fits beside the QR stacked, but beside the text it would
        // have to start at row 10 and end lower.
        // 14 two-column questions fill page 1 (its QR cap), so the next question starts page 2.
        const filler = Array.from({ length: 14 }, () => ({ prompt: "Filler", choices: ["a", "b"] }));
        const top = paginate({ title: "T", questions: [...filler, q([fig(250, 200)], long)] }).at(-1)!.questions.at(-1)!;
        expect(top.promptRow).toBe(LAYOUT.topRowContinued);
        expect(stacked(top)).toBe(true);
        // Choices that would wrap in the width left of the figure.
        const longer = long.map((c) => `${c} and stays there for good`);
        expect(stacked(paginate({ title: "T", questions: [q([fig(250, 200)], longer)] })[0]!.questions[0]!)).toBe(true);
        // A figure wider than a column.
        const column = textRightEdge(LAYOUT.qrClearRow) - colX(LAYOUT.columns.right.promptCol);
        expect(stacked(paginate({ title: "T", questions: [q([fig(column + 10, 200)], long)] })[0]!.questions[0]!)).toBe(true);
    });

    test("the renderer gives each placement its own id prefix", () => {
        const shared = ok(prep({ content: svg(`<defs><marker id="m"><path d="M0 0"/></marker></defs><line marker-end="url(#m)"/>`), caption: "Fig" }));
        const [p] = renderTest({ title: "T", questions: [q([shared]), q([shared])] });
        expect(p!.svg).toContain(`id="p1f1-m"`);
        expect(p!.svg).toContain(`id="p1f2-m"`);
        expect(p!.svg).toContain(">Fig</text>");
        expect(p!.svg).toContain(`xmlns:xlink="http://www.w3.org/1999/xlink"`);
    });
});

describe("figures in the sheet JSON", () => {
    const doc = (extra: object, questions: object[] = [{ prompt: "p", figures: ["graph"], choices: ["a", "b"] }]) =>
        JSON.stringify({ test: "T", questions, figures: { graph: { type: "svg", content: svg("<rect/>") }, ...extra } });

    test("the example with figures parses", async () => {
        const r = parseSheetJson(await Bun.file(new URL("../examples/figures-demo.json", import.meta.url)).text());
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.notes).toEqual([]);
            expect(r.test.questions[2]!.figures!.map((f) => f.id)).toEqual(["loanable-funds", "yields"]);
        }
    });

    test("unknown ids get a suggestion; an unused figure is a note", () => {
        const r = parseSheetJson(doc({ table: { type: "table", content: "<table><tr><td>1</td></tr></table>" } }, [{ prompt: "p", figures: ["Grpah", "graph", "graph"], choices: ["a", "b"] }]));
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.errors).toContainEqual({ path: "questions[0].figures[0]", where: "Question 1, figures", message: `No figure "Grpah". Did you mean "graph"?` });
            expect(r.errors).toContainEqual({ path: "questions[0].figures[2]", where: "Question 1, figures", message: `Lists "graph" twice.` });
        }
        const unused = parseSheetJson(doc({ table: { type: "table", content: "<table><tr><td>1</td></tr></table>" } }));
        expect(unused.ok && unused.notes).toEqual([{ path: "figures.table", where: `Figure "table"`, message: "Isn't used by any question, so it isn't printed." }]);
    });

    test("figure definitions are checked with paths", () => {
        const r = parseSheetJson(
            doc({
                "bad id": { type: "svg", content: svg("") },
                pic: { type: "png", content: "x", width: -1, svg: "" },
                broken: { type: "svg", content: svg("<script/>") },
            }),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            const paths = r.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
            expect(paths).toMatch(/figures.bad id: Ids may use/);
            expect(paths).toMatch(/figures.pic.type: "type" must be "svg" or "table"/);
            expect(paths).toMatch(/figures.pic.width: "width" must be a number/);
            expect(paths).toMatch(/figures.pic.svg: Unknown key "svg". Did you mean "content"\?/);
            expect(paths).toMatch(/figures.broken.content: Line 1, <script>: scripts aren't allowed/);
        }
    });

    test("a question whose figures can't fit on a page says how many rows they take", () => {
        const r = parseSheetJson(
            JSON.stringify({
                test: "T",
                questions: [{ prompt: "p", figures: ["tall"], choices: ["a", "b"] }],
                figures: { tall: { type: "svg", content: svg("", `viewBox="0 0 100 200"`), width: 5 } },
            }),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors[0]!.message).toMatch(/its figures take 58 of a page's 54 rows/);
    });
});
