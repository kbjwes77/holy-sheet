// Question figures: SVG drawings and HTML tables, checked strictly and turned into SVG that the
// sheet renderer places between a question's prompt and its choices. Everything that prints is
// plain SVG (tables become lines and text), so the browser preview and the PDF (svg2pdf.js,
// which can't draw HTML) are the same. Unsupported content is an error, never silently dropped.
import { textWidth, unprintable, wrapWidth } from "./textwidth.ts";
import { escapeXml, parseXml, XmlError, type XmlElement, type XmlNode } from "./xml.ts";

export const FIGURE_TYPES = ["svg", "table"] as const;
export type FigureType = (typeof FIGURE_TYPES)[number];

/** A figure as written in the test JSON (`figures.<id>`). */
export interface FigureDef {
    type: FigureType;
    content: string;
    /** Printed width in inches; otherwise the figure's natural size. */
    width?: number;
    caption?: string;
}

/** A checked figure, ready to place. Sizes are page units (1/100 in). */
export interface Figure {
    id: string;
    /** The drawing's printed size. */
    w: number;
    h: number;
    /** The figure with its caption: the drawing is centred in `boxW`, the caption under it. */
    boxW: number;
    boxH: number;
    captionLines: string[];
    /** The drawing in a `w` × `h` box at the origin. `prefix` keeps its ids unique on the page. */
    draw(prefix: string): string;
}

export type PrepareResult = { ok: true; figure: Figure } | { ok: false; errors: string[] };

export const FIGURE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_FIGURE_CONTENT = 500_000;
const UNITS_PER_IN = 100;
const PX_PER_IN = 96;

const FONT = "Arial, Helvetica, sans-serif";
export const CAPTION_SIZE = 9;
const CAPTION_LEAD = 11;
const CAPTION_GAP = 4;
/** Captions on narrow figures may run this wide (centred under the figure) before wrapping. */
const CAPTION_MIN_W = 200;
const MAX_ERRORS = 12;

const f = (n: number) => +n.toFixed(2);

/** Checks a figure and prepares it for printing at most `maxWidth` page units wide. */
export function prepareFigure(id: string, def: FigureDef, maxWidth: number): PrepareResult {
    const errors: string[] = [];
    if (def.width !== undefined && def.width * UNITS_PER_IN > maxWidth + 0.5) {
        errors.push(`"width" is ${def.width} in, wider than the text column (${(maxWidth / UNITS_PER_IN).toFixed(2)} in).`);
    }
    let root: XmlElement;
    try {
        root = parseXml(def.content, { html: def.type === "table" });
    } catch (e) {
        if (!(e instanceof XmlError)) throw e;
        return { ok: false, errors: [`Can't read the ${def.type === "svg" ? "SVG" : "table"}: ${e.message}.`, ...errors] };
    }
    const drawing = def.type === "svg" ? svgDrawing(root, def, maxWidth, errors) : tableDrawing(root, def, maxWidth, errors);
    if (errors.length || !drawing) {
        const shown = errors.slice(0, MAX_ERRORS);
        if (errors.length > MAX_ERRORS) shown.push(`…and ${errors.length - MAX_ERRORS} more problems.`);
        return { ok: false, errors: shown };
    }
    const caption = def.caption?.trim() ?? "";
    let boxW = drawing.w;
    let captionLines: string[] = [];
    if (caption) {
        boxW = Math.min(maxWidth, Math.max(drawing.w, Math.min(textWidth(caption, CAPTION_SIZE), CAPTION_MIN_W)));
        captionLines = wrapWidth(caption, boxW, CAPTION_SIZE);
    }
    const boxH = drawing.h + (captionLines.length ? CAPTION_GAP + captionLines.length * CAPTION_LEAD : 0);
    return { ok: true, figure: { id, ...drawing, boxW, boxH, captionLines } };
}

/** The figure and its caption, with the box's top-left corner at (x, y). */
export function renderFigure(fig: Figure, x: number, y: number, prefix: string): string {
    const dx = x + (fig.boxW - fig.w) / 2;
    let out = `<g transform="translate(${f(dx)} ${f(y)})">${fig.draw(prefix)}</g>`;
    fig.captionLines.forEach((line, i) => {
        const by = y + fig.h + CAPTION_GAP + (i + 0.8) * CAPTION_LEAD;
        out += `<text x="${f(x + fig.boxW / 2)}" y="${f(by)}" font-family="${FONT}" font-size="${CAPTION_SIZE}" text-anchor="middle" fill="#333">${escapeXml(line)}</text>`;
    });
    return out;
}

/** Final width for a figure whose natural width is `natural` units. */
function printedWidth(natural: number, def: FigureDef, maxWidth: number): number {
    return Math.min(def.width !== undefined ? def.width * UNITS_PER_IN : natural, maxWidth);
}

// ---- SVG -------------------------------------------------------------------

const SVG_ELEMENTS = new Set([
    "g",
    "defs",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "marker",
    "use",
    "symbol",
]);
/** Elements that never print: dropped without comment. */
const SVG_SKIPPED = new Set(["title", "desc", "metadata"]);
const EDITOR_PREFIXES = ["sodipodi:", "inkscape:", "rdf:", "cc:", "dc:", "sketch:", "serif:"];
const SVG_REJECTED: Record<string, string> = {
    script: "scripts aren't allowed",
    style: `<style> blocks aren't supported; put the styles on the elements as attributes or style="…"`,
    foreignObject: "<foreignObject> (HTML inside SVG) can't be printed",
    image: "images aren't supported; draw it as SVG shapes",
    a: "links aren't supported; use <g> instead",
    animate: "animation isn't supported",
    animateTransform: "animation isn't supported",
    animateMotion: "animation isn't supported",
    set: "animation isn't supported",
    filter: "filters aren't supported",
    mask: "masks aren't supported; use a clipPath",
    pattern: "patterns aren't supported",
    svg: "an <svg> inside the figure isn't supported; use <g> with a transform",
    textPath: "text on a path isn't supported",
    switch: "<switch> isn't supported",
};

const PRESENTATION = new Set([
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "opacity",
    "stop-color",
    "stop-opacity",
    "clip-path",
    "clip-rule",
    "marker-start",
    "marker-mid",
    "marker-end",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "dominant-baseline",
    "alignment-baseline",
    "baseline-shift",
    "letter-spacing",
    "word-spacing",
    "text-decoration",
    "display",
    "visibility",
    "color",
]);
const GEOMETRY = new Set([
    "x",
    "y",
    "width",
    "height",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "x1",
    "y1",
    "x2",
    "y2",
    "fx",
    "fy",
    "fr",
    "points",
    "d",
    "dx",
    "dy",
    "rotate",
    "textLength",
    "lengthAdjust",
    "transform",
    "viewBox",
    "preserveAspectRatio",
    "offset",
    "gradientUnits",
    "gradientTransform",
    "spreadMethod",
    "clipPathUnits",
    "markerWidth",
    "markerHeight",
    "refX",
    "refY",
    "orient",
    "markerUnits",
]);
/** Attributes and style properties that don't change what prints: dropped without comment. */
const IGNORED = new Set([
    "version",
    "baseProfile",
    "xml:space",
    "enable-background",
    "shape-rendering",
    "text-rendering",
    "image-rendering",
    "color-rendering",
    "color-interpolation",
    "color-interpolation-filters",
    "overflow",
    "pointer-events",
    "cursor",
    "role",
    "focusable",
    "isolation",
    "mix-blend-mode",
    "paint-order",
    "line-height",
    "font-stretch",
    "font-variant",
    "font-variant-ligatures",
    "font-variant-caps",
    "font-variant-numeric",
    "font-variant-east-asian",
    "font-feature-settings",
    "writing-mode",
    "direction",
    "vector-effect",
]);
const ignoredName = (k: string) =>
    IGNORED.has(k) || k === "xmlns" || k.startsWith("xmlns:") || k.startsWith("data-") || k.startsWith("aria-") || k.startsWith("-") || EDITOR_PREFIXES.some((p) => k.startsWith(p));

const FONTS = new Set(["arial", "helvetica", "sans-serif", "times", "times new roman", "serif", "courier", "courier new", "monospace"]);
const URL_REF = /url\(\s*['"]?([^'")]*)['"]?\s*\)/g;

/** Root attributes that size the figure rather than style it. */
const ROOT_SIZING = new Set(["width", "height", "viewBox", "preserveAspectRatio", "x", "y"]);

const LENGTH = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|in|cm|mm|pt|pc)?\s*$/i;
const PX: Record<string, number> = { px: 1, in: PX_PER_IN, cm: PX_PER_IN / 2.54, mm: PX_PER_IN / 25.4, pt: PX_PER_IN / 72, pc: 16 };

function svgDrawing(root: XmlElement, def: FigureDef, maxWidth: number, errors: string[]): { w: number; h: number; draw(prefix: string): string } | null {
    if (root.name !== "svg") {
        errors.push(`The content must be one <svg> element, not <${root.name}>.`);
        return null;
    }
    const ids = new Set<string>();
    const refs: { id: string; line: number }[] = [];
    const err = (el: XmlElement, msg: string) => errors.push(`Line ${el.line}, <${el.name}>: ${msg}.`);

    const checkValue = (el: XmlElement, prop: string, v: string) => {
        for (const m of v.matchAll(URL_REF)) {
            if (!m[1]!.startsWith("#")) err(el, `${prop} links to "${m[1]}"; only references inside the figure (url(#id)) are allowed`);
            else refs.push({ id: m[1]!.slice(1), line: el.line });
        }
        if (prop === "font-family") {
            for (const fam of v.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "").toLowerCase())) {
                if (fam && !FONTS.has(fam)) err(el, `font "${fam}" isn't available in the PDF; use Arial/Helvetica, Times or Courier (or sans-serif, serif, monospace)`);
            }
        }
    };

    /** Allowed attributes of `el`, with style="…" declarations turned into attributes. */
    const cleanAttrs = (el: XmlElement, isRoot: boolean): [string, string][] => {
        const out = new Map<string, string>();
        const fromStyle = new Map<string, string>();
        for (const [k, v] of el.attrs) {
            if (isRoot && ROOT_SIZING.has(k)) continue;
            if (ignoredName(k)) continue;
            if (/^on/i.test(k)) err(el, `event handlers (${k}) aren't allowed`);
            else if (k === "class") err(el, `"class" isn't supported (there's no <style>); put the styles on the element`);
            else if (k === "style") {
                for (const decl of v.split(";")) {
                    if (!decl.trim()) continue;
                    const colon = decl.indexOf(":");
                    const prop = decl.slice(0, colon).trim().toLowerCase();
                    const val = decl.slice(colon + 1).trim();
                    if (colon < 0 || !prop) err(el, `can't read style "${decl.trim()}"`);
                    else if (ignoredName(prop)) continue;
                    else if (prop === "font") err(el, `the "font" shorthand isn't supported; use font-family, font-size and font-weight`);
                    else if (!PRESENTATION.has(prop)) err(el, `style property "${prop}" isn't supported`);
                    else {
                        checkValue(el, prop, val);
                        fromStyle.set(prop, val.replace(/\s*!important$/, ""));
                    }
                }
            } else if (k === "href" || k === "xlink:href") {
                if (el.name !== "use") err(el, `"${k}" is only supported on <use>`);
                else if (!v.startsWith("#")) err(el, `<use> must point inside the figure (href="#id"), not "${v}"`);
                else {
                    refs.push({ id: v.slice(1), line: el.line });
                    out.set("xlink:href", v);
                }
            } else if (k === "id") {
                ids.add(v);
                out.set(k, v);
            } else if (PRESENTATION.has(k)) {
                checkValue(el, k, v);
                out.set(k, v);
            } else if (GEOMETRY.has(k)) out.set(k, v);
            else err(el, `attribute "${k}" isn't supported`);
        }
        // CSS in style="…" wins over presentation attributes.
        for (const [k, v] of fromStyle) out.set(k, v);
        return [...out];
    };

    const clean = (el: XmlElement, inText: boolean): XmlNode[] => {
        const out: XmlNode[] = [];
        for (const n of el.children) {
            if (n.kind === "text") {
                if (inText) {
                    const bad = unprintable(n.text);
                    if (bad) err(el, `the text contains ${bad}, which can't be printed with the PDF's fonts`);
                    out.push(n);
                }
                continue;
            }
            if (SVG_SKIPPED.has(n.name) || EDITOR_PREFIXES.some((p) => n.name.startsWith(p))) continue;
            const reason = SVG_REJECTED[n.name];
            if (reason) {
                err(n, reason);
                continue;
            }
            if (!SVG_ELEMENTS.has(n.name)) {
                err(n, `this element isn't supported`);
                continue;
            }
            out.push({ ...n, attrs: cleanAttrs(n, false), children: clean(n, n.name === "text" || n.name === "tspan") });
        }
        return out;
    };

    const rootAttrs = cleanAttrs(root, true);
    const body = clean(root, false);
    for (const r of refs) if (!ids.has(r.id)) errors.push(`Line ${r.line}: refers to "#${r.id}", which isn't defined in the figure.`);

    // Size: width/height (any CSS unit) and/or viewBox.
    const attr = (k: string) => root.attrs.find(([n]) => n === k)?.[1];
    const length = (k: string): number | undefined => {
        const v = attr(k);
        if (v === undefined || v === "auto") return undefined;
        const m = LENGTH.exec(v);
        if (!m || Number(m[1]) <= 0) {
            err(root, `${k}="${v}" isn't a size this can use; give it in px, in, cm, mm or pt (not %)`);
            return undefined;
        }
        return Number(m[1]) * PX[(m[2] ?? "px").toLowerCase()]!;
    };
    let W = length("width");
    let H = length("height");
    let vb: number[] | undefined;
    const vbRaw = attr("viewBox");
    if (vbRaw !== undefined) {
        vb = vbRaw.trim().split(/[\s,]+/).map(Number);
        if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || vb[2]! <= 0 || vb[3]! <= 0) {
            err(root, `viewBox="${vbRaw}" must be four numbers: min-x min-y width height`);
            vb = undefined;
        }
    }
    if (vb) {
        if (W === undefined && H === undefined) [W, H] = [vb[2]!, vb[3]!];
        else if (W === undefined) W = (H! * vb[2]!) / vb[3]!;
        else if (H === undefined) H = (W * vb[3]!) / vb[2]!;
    } else if (W !== undefined && H !== undefined) vb = [0, 0, W, H];
    if (!vb || W === undefined || H === undefined) {
        if (!errors.length) err(root, "needs a viewBox, or both width and height, to know its size");
        return null;
    }
    if (errors.length) return null;

    const w = printedWidth((W * UNITS_PER_IN) / PX_PER_IN, def, maxWidth);
    const h = (w * H) / W;
    const transform = viewBoxTransform(vb, w, h, attr("preserveAspectRatio"));
    const draw = (prefix: string) => {
        const rewrite = (k: string, v: string) =>
            k === "id" ? prefix + v : k === "xlink:href" ? `#${prefix}${v.slice(1)}` : v.replace(URL_REF, (_, id: string) => `url(#${prefix}${id.slice(1)})`);
        const ser = (n: XmlNode): string =>
            n.kind === "text"
                ? escapeXml(n.text)
                : `<${n.name}${n.attrs.map(([k, v]) => ` ${k}="${escapeXml(rewrite(k, v))}"`).join("")}>${n.children.map(ser).join("")}</${n.name}>`;
        const style = rootAttrs.map(([k, v]) => ` ${k}="${escapeXml(rewrite(k, v))}"`).join("");
        return (
            `<defs><clipPath id="${prefix}box"><rect width="${f(w)}" height="${f(h)}"/></clipPath></defs>` +
            `<g clip-path="url(#${prefix}box)"><g transform="${transform}" font-family="${FONT}"${style}>${body.map(ser).join("")}</g></g>`
        );
    };
    return { w, h, draw };
}

/** Maps the viewBox onto a w × h box, following preserveAspectRatio (default xMidYMid meet). */
function viewBoxTransform(vb: number[], w: number, h: number, par: string | undefined): string {
    const [vx, vy, vw, vh] = vb as [number, number, number, number];
    let sx = w / vw;
    let sy = h / vh;
    let tx = 0;
    let ty = 0;
    const [align = "xMidYMid", mode = "meet"] = (par ?? "").trim().split(/\s+/).filter(Boolean);
    if (align !== "none") {
        const s = mode === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
        sx = sy = s;
        const pos = (a: string, free: number) => (a === "Min" ? 0 : a === "Max" ? free : free / 2);
        tx = pos(align.slice(1, 4), w - vw * s);
        ty = pos(align.slice(5, 8), h - vh * s);
    }
    return `translate(${f(tx)} ${f(ty)}) scale(${+sx.toFixed(5)} ${+sy.toFixed(5)}) translate(${f(-vx)} ${f(-vy)})`;
}

// ---- Tables ----------------------------------------------------------------

const TABLE_SIZE = 10;
const ROW_H = 17.5;
const PAD_X = 5;
const HEADER_FILL = "#e6e6e6";
const RULE = 0.75;
const MAX_SPAN = 50;

interface Run {
    text: string;
    bold: boolean;
    italic: boolean;
    shift: "" | "sub" | "sup";
}

interface Cell {
    runs: Run[];
    header: boolean;
    align: "left" | "center" | "right";
    row: number;
    col: number;
    rowspan: number;
    colspan: number;
}

const INLINE: Record<string, Partial<Run>> = { b: { bold: true }, strong: { bold: true }, i: { italic: true }, em: { italic: true }, sub: { shift: "sub" }, sup: { shift: "sup" } };
const NUMERIC = /^[\s(]*[-+−–]?\s*[$€£¥]?\s*[-+]?\d[\d.,]*\s*%?\s*\)?\s*$/;

const runSize = (r: Run) => (r.shift ? TABLE_SIZE * 0.7 : TABLE_SIZE);
const runWidth = (r: Run) => textWidth(r.text, runSize(r), r.bold);
const runsWidth = (runs: Run[]) => runs.reduce((s, r) => s + runWidth(r), 0);

function tableDrawing(root: XmlElement, def: FigureDef, maxWidth: number, errors: string[]): { w: number; h: number; draw(): string } | null {
    if (root.name !== "table") {
        errors.push(`The content must be one <table> element, not <${root.name}>.`);
        return null;
    }
    const err = (el: XmlElement, msg: string) => errors.push(`Line ${el.line}, <${el.name}>: ${msg}.`);
    const onlySpace = (el: XmlElement, n: XmlNode) => {
        if (n.kind === "text" && n.text.trim()) err(el, `text "${n.text.trim().slice(0, 20)}" must be inside a <td> or <th>`);
    };

    /** Inline content → runs with whitespace collapsed (non-breaking spaces kept). */
    const runsOf = (el: XmlElement, style: Run): Run[] => {
        const runs: Run[] = [];
        for (const n of el.children) {
            if (n.kind === "text") {
                const bad = unprintable(n.text);
                if (bad) err(el, `contains ${bad}, which can't be printed with the sheet's font`);
                runs.push({ ...style, text: n.text.replace(/[ \t\r\n\f]+/g, " ") });
            } else if (INLINE[n.name]) {
                if (n.attrs.length) err(n, `attributes aren't supported here`);
                runs.push(...runsOf(n, { ...style, ...INLINE[n.name] }));
            } else if (n.name === "br") err(n, "cells hold one line of text; <br> isn't supported");
            else err(n, `isn't supported inside a cell (use <b>, <i>, <sub> or <sup>)`);
        }
        return runs;
    };
    const tidy = (runs: Run[]): Run[] => {
        // Collapse spaces across run boundaries and trim the ends.
        const out: Run[] = [];
        let lastSpace = true;
        for (const r of runs) {
            let t = r.text;
            if (lastSpace) t = t.replace(/^ /, "");
            if (!t) continue;
            lastSpace = t.endsWith(" ");
            out.push({ ...r, text: t });
        }
        if (out.length) out[out.length - 1]!.text = out.at(-1)!.text.replace(/ $/, "");
        return out.filter((r) => r.text);
    };
    const plain: Run = { text: "", bold: false, italic: false, shift: "" };

    let caption = null as Run[] | null;
    const rows: XmlElement[] = [];
    for (const [k] of root.attrs) if (!["border", "cellpadding", "cellspacing"].includes(k)) err(root, `attribute "${k}" isn't supported`);
    root.children.forEach((n) => {
        if (n.kind === "text") return onlySpace(root, n);
        if (n.name === "caption") {
            if (caption) err(n, "a table has only one caption");
            if (n.attrs.length) err(n, "attributes aren't supported here");
            caption = tidy(runsOf(n, plain));
        } else if (n.name === "thead" || n.name === "tbody") {
            if (n.attrs.length) err(n, "attributes aren't supported here");
            for (const r of n.children) {
                if (r.kind === "text") onlySpace(n, r);
                else if (r.name === "tr") rows.push(r);
                else err(r, `<${n.name}> can only contain <tr>`);
            }
        } else if (n.name === "tr") rows.push(n);
        else err(n, `isn't supported in a table (use <caption>, <thead>, <tbody>, <tr>, <th> and <td>)`);
    });
    if (!rows.length) err(root, "the table has no rows");

    // Place cells on a grid, honouring rowspan/colspan as HTML does.
    const cells: Cell[] = [];
    const taken: boolean[][] = rows.map(() => []);
    rows.forEach((tr, r) => {
        if (tr.attrs.length) err(tr, "attributes aren't supported here");
        let c = 0;
        for (const n of tr.children) {
            if (n.kind === "text") {
                onlySpace(tr, n);
                continue;
            }
            if (n.name !== "td" && n.name !== "th") {
                err(n, "a row can only contain <td> and <th>");
                continue;
            }
            let rowspan = 1;
            let colspan = 1;
            let align: Cell["align"] | null = null;
            for (const [k, v] of n.attrs) {
                if (k === "rowspan" || k === "colspan") {
                    const span = Number(v);
                    if (!Number.isInteger(span) || span < 1 || span > MAX_SPAN) err(n, `${k}="${v}" must be a whole number from 1 to ${MAX_SPAN}`);
                    else if (k === "rowspan") rowspan = span;
                    else colspan = span;
                } else if (k === "align") {
                    if (!["left", "center", "right"].includes(v.toLowerCase())) err(n, `align="${v}" must be left, center or right`);
                    else align = v.toLowerCase() as Cell["align"];
                } else if (k === "style") {
                    for (const decl of v.split(";").filter((d) => d.trim())) {
                        const [prop, val = ""] = decl.split(":").map((s) => s.trim().toLowerCase());
                        if (prop === "text-align" && ["left", "center", "right"].includes(val)) align = val as Cell["align"];
                        else err(n, `style "${decl.trim()}" isn't supported (only text-align: left, center or right)`);
                    }
                } else err(n, `attribute "${k}" isn't supported`);
            }
            while (taken[r]![c]) c++;
            rowspan = Math.min(rowspan, rows.length - r);
            for (let rr = r; rr < r + rowspan; rr++) for (let cc = c; cc < c + colspan; cc++) taken[rr]![cc] = true;
            const header = n.name === "th";
            const runs = tidy(runsOf(n, { ...plain, bold: header }));
            const text = runs.map((x) => x.text).join("");
            cells.push({ runs, header, align: align ?? (header ? "center" : NUMERIC.test(text) ? "right" : "left"), row: r, col: c, rowspan, colspan });
            c += colspan;
        }
    });
    if (errors.length) return null;

    // Column widths: single-span cells first, then widen spanned columns where a spanning cell needs it.
    const nCols = Math.max(1, ...taken.map((row) => row.length));
    const colW = Array.from({ length: nCols }, () => 2 * PAD_X);
    const need = (cell: Cell) => runsWidth(cell.runs) + 2 * PAD_X;
    for (const cell of cells) if (cell.colspan === 1) colW[cell.col] = Math.max(colW[cell.col]!, need(cell));
    for (const cell of [...cells].filter((x) => x.colspan > 1).sort((a, b) => a.colspan - b.colspan)) {
        const span = colW.slice(cell.col, cell.col + cell.colspan);
        const extra = need(cell) - span.reduce((s, x) => s + x, 0);
        if (extra > 0) for (let cc = cell.col; cc < cell.col + cell.colspan; cc++) colW[cc]! += extra / cell.colspan;
    }
    const captionRuns = caption;
    let natural = colW.reduce((s, x) => s + x, 0);
    if (captionRuns) {
        const extra = runsWidth(captionRuns) + 2 * PAD_X - natural;
        if (extra > 0) {
            for (let cc = 0; cc < nCols; cc++) colW[cc]! += extra / nCols;
            natural += extra;
        }
    }
    // Printed size: stretch columns to a wider requested width; shrink everything to a narrower one.
    const target = printedWidth(natural, def, maxWidth);
    let scale = 1;
    if (target >= natural) for (let cc = 0; cc < nCols; cc++) colW[cc]! *= target / natural;
    else scale = target / natural;
    const tableW = colW.reduce((s, x) => s + x, 0);
    const top = captionRuns ? ROW_H : 0;
    const naturalH = top + rows.length * ROW_H;
    const colX = colW.reduce<number[]>((xs, cw) => [...xs, xs.at(-1)! + cw], [0]);

    const textRuns = (runs: Run[], x: number, baseline: number): string => {
        let out = "";
        for (const r of runs) {
            const dy = r.shift === "sub" ? 0.3 * TABLE_SIZE : r.shift === "sup" ? -0.35 * TABLE_SIZE : 0;
            const attrs = `${r.bold ? ` font-weight="bold"` : ""}${r.italic ? ` font-style="italic"` : ""}`;
            // SVG drops spaces at the ends of a <text>, so they become gaps in x instead.
            const space = textWidth(" ", runSize(r), r.bold);
            const text = r.text.replace(/^ | $/g, "");
            if (r.text.startsWith(" ")) x += space;
            if (text) out += `<text x="${f(x)}" y="${f(baseline + dy)}" font-family="${FONT}" font-size="${f(runSize(r))}"${attrs}>${escapeXml(text)}</text>`;
            x += textWidth(text, runSize(r), r.bold) + (r.text.length > 1 && r.text.endsWith(" ") ? space : 0);
        }
        return out;
    };
    const draw = () => {
        let out = "";
        if (captionRuns) out += textRuns(captionRuns, (tableW - runsWidth(captionRuns)) / 2, ROW_H * 0.7);
        for (const cell of cells) {
            const x = colX[cell.col]!;
            const w = colX[cell.col + cell.colspan]! - x;
            const y = top + cell.row * ROW_H;
            const h = cell.rowspan * ROW_H;
            out += `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${cell.header ? HEADER_FILL : "none"}" stroke="#000" stroke-width="${RULE}"/>`;
            const tw = runsWidth(cell.runs);
            const tx = cell.align === "left" ? x + PAD_X : cell.align === "right" ? x + w - PAD_X - tw : x + (w - tw) / 2;
            out += textRuns(cell.runs, tx, y + h / 2 + TABLE_SIZE * 0.35);
        }
        return scale === 1 ? out : `<g transform="scale(${+scale.toFixed(5)})">${out}</g>`;
    };
    return { w: tableW * scale, h: naturalH * scale, draw };
}
