// A small strict XML parser for figure content (SVG, and HTML tables written as well-formed
// markup). Pure TypeScript so the validator and renderer run the same in Bun and the browser,
// where DOMParser isn't available to Bun.

export interface XmlElement {
    kind: "element";
    name: string;
    attrs: [string, string][];
    children: XmlNode[];
    /** 1-based line of the start tag, for error messages. */
    line: number;
}

export interface XmlText {
    kind: "text";
    text: string;
}

export type XmlNode = XmlElement | XmlText;

export class XmlError extends Error {
    override name = "XmlError";
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// Named entities accepted in HTML mode (tables), beyond the XML five.
const HTML_ENTITIES: Record<string, string> = {
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    hellip: "…",
    deg: "°",
    plusmn: "±",
    times: "×",
    divide: "÷",
    middot: "·",
    frac12: "½",
    frac14: "¼",
    frac34: "¾",
    sup1: "¹",
    sup2: "²",
    sup3: "³",
    cent: "¢",
    pound: "£",
    euro: "€",
    yen: "¥",
    copy: "©",
    reg: "®",
    micro: "µ",
    para: "¶",
    sect: "§",
};

export interface ParseOptions {
    /** HTML mode: tag and attribute names are case-insensitive (lowercased) and HTML entities are known. */
    html?: boolean;
}

/** Parses `src` into its single root element. Comments, `<?…?>` and a plain DOCTYPE are skipped. */
export function parseXml(src: string, opts: ParseOptions = {}): XmlElement {
    let i = 0;
    const lineAt = (at: number) => src.slice(0, at).split("\n").length;
    const fail = (msg: string, at = i): never => {
        throw new XmlError(`${msg} (line ${lineAt(at)})`);
    };
    const norm = (name: string) => (opts.html ? name.toLowerCase() : name);

    const decode = (s: string, at: number): string =>
        s.replace(/&([^;\s&<]*);?/g, (m, name: string) => {
            if (!m.endsWith(";")) fail(`"&" must start an entity such as &amp;`, at);
            if (name.startsWith("#")) {
                const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
                if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) fail(`bad character reference "${m}"`, at);
                return String.fromCodePoint(code);
            }
            const v = XML_ENTITIES[name] ?? (opts.html ? HTML_ENTITIES[name] : undefined);
            if (v === undefined) fail(`unknown entity "${m}"`, at);
            return v!;
        });

    /** Skips comments, processing instructions and DOCTYPE; returns true if it skipped something. */
    const skipMisc = (): boolean => {
        if (src.startsWith("<!--", i)) {
            const end = src.indexOf("-->", i + 4);
            if (end < 0) fail("unclosed comment");
            i = end + 3;
            return true;
        }
        if (src.startsWith("<?", i)) {
            const end = src.indexOf("?>", i + 2);
            if (end < 0) fail("unclosed <?…?>");
            i = end + 2;
            return true;
        }
        if (/^<!doctype/i.test(src.slice(i, i + 9))) {
            const end = src.indexOf(">", i);
            if (end < 0) fail("unclosed DOCTYPE");
            if (src.slice(i, end).includes("[")) fail("a DOCTYPE with its own definitions isn't supported");
            i = end + 1;
            return true;
        }
        return false;
    };

    const NAME = /[A-Za-z_][\w:.-]*/y;
    const readName = (): string => {
        NAME.lastIndex = i;
        const m = NAME.exec(src);
        if (!m) fail("expected a tag or attribute name");
        i += m![0].length;
        return m![0];
    };
    const skipSpace = () => {
        while (i < src.length && /\s/.test(src[i]!)) i++;
    };

    const element = (): XmlElement => {
        const start = i;
        i++; // <
        const name = norm(readName());
        const el: XmlElement = { kind: "element", name, attrs: [], children: [], line: lineAt(start) };
        const seen = new Set<string>();
        for (;;) {
            skipSpace();
            if (i >= src.length) fail(`unclosed <${name}> tag`, start);
            if (src.startsWith("/>", i)) {
                i += 2;
                return el;
            }
            if (src[i] === ">") {
                i++;
                break;
            }
            const at = i;
            const attr = norm(readName());
            skipSpace();
            if (src[i] !== "=") fail(`attribute "${attr}" on <${name}> needs a value, like ${attr}="…"`, at);
            i++;
            skipSpace();
            const q = src[i];
            if (q !== '"' && q !== "'") fail(`the value of "${attr}" on <${name}> must be in quotes`, at);
            const end = src.indexOf(q!, i + 1);
            if (end < 0) fail(`unclosed value of "${attr}" on <${name}>`, at);
            const raw = src.slice(i + 1, end);
            if (raw.includes("<")) fail(`"<" in the value of "${attr}" on <${name}>`, at);
            i = end + 1;
            if (seen.has(attr)) fail(`<${name}> has "${attr}" twice`, at);
            seen.add(attr);
            el.attrs.push([attr, decode(raw, at)]);
        }
        // Children until the matching end tag.
        for (;;) {
            if (i >= src.length) fail(`<${name}> is never closed`, start);
            if (src.startsWith("</", i)) {
                const at = i;
                i += 2;
                const close = norm(readName());
                skipSpace();
                if (src[i] !== ">") fail(`bad closing tag </${close}`, at);
                i++;
                if (close !== name) fail(`</${close}> closes <${name}> (from line ${el.line})`, at);
                return el;
            }
            if (src.startsWith("<![CDATA[", i)) {
                const end = src.indexOf("]]>", i);
                if (end < 0) fail("unclosed CDATA section");
                el.children.push({ kind: "text", text: src.slice(i + 9, end) });
                i = end + 3;
                continue;
            }
            if (src[i] === "<") {
                if (skipMisc()) continue;
                el.children.push(element());
                continue;
            }
            const next = src.indexOf("<", i);
            const end = next < 0 ? src.length : next;
            el.children.push({ kind: "text", text: decode(src.slice(i, end), i) });
            i = end;
        }
    };

    let root: XmlElement | null = null;
    for (;;) {
        skipSpace();
        if (i >= src.length) break;
        if (skipMisc()) continue;
        if (src[i] !== "<") fail(root ? "text after the closing tag" : "text before the first tag");
        if (root) fail(`a second top-level element after </${root.name}>`);
        root = element();
    }
    if (!root) throw new XmlError("no markup found");
    return root;
}

/** Escapes text or an attribute value for output. */
export function escapeXml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
