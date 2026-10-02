// Builds a single self-contained HTML file (dist/web/sheet-generator.html) that works when
// opened straight from disk: the app is bundled as a classic IIFE script and inlined with its
// CSS, since browsers block module scripts on file:// URLs. Bootstrap still loads from its CDN.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
const outDir = join(root, "..", "dist", "web");
const outFile = join(outDir, "sheet-generator.html");

const result = await Bun.build({
    entrypoints: [join(root, "app.ts")],
    target: "browser",
    format: "iife",
    minify: true,
    // jsPDF lazy-loads these for doc.html()/canvas features this app never uses.
    external: ["html2canvas", "canvg", "dompurify"],
});
if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
}
const js = (await result.outputs[0]!.text()).replace(/<\/script/gi, "<\\/script");
const css = await Bun.file(join(root, "app.css")).text();
let html = await Bun.file(join(root, "index.html")).text();

const swap = (from: string, to: string) => {
    if (!html.includes(from)) throw new Error(`build: ${from} not found in index.html`);
    html = html.replace(from, () => to);
};
html = html.replace(/[ \t]*<!-- source-only:start -->[\s\S]*?<!-- source-only:end -->\n?/, "");
swap(`<link rel="stylesheet" href="./app.css" />`, `<style>\n${css}</style>`);
swap(`<script type="module" src="./app.ts"></script>`, `<script>${js}</script>`);

await mkdir(outDir, { recursive: true });
await Bun.write(outFile, html);
console.log(`Wrote ${outFile} (${(html.length / 1024).toFixed(0)} KB)`);
