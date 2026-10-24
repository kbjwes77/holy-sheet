// Links Bootstrap, Bootstrap Icons and the landing page fonts from node_modules into public/{css,fonts}: `bun run vendor`
// (also runs after `bun install`). The links are relative, so they survive moving the checkout.
// Where symlinks aren't allowed (Windows without Developer Mode) it copies the files instead.
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const pub = join(root, "public");
const modules = join(root, "node_modules");

// [link inside public/, target]
const files: [string, string][] = [
    ["css/bootstrap.min.css", "bootstrap/dist/css/bootstrap.min.css"],
    ["css/bootstrap-icons.min.css", "bootstrap-icons/font/bootstrap-icons.min.css"],
    ["fonts/bootstrap-icons.woff2", "bootstrap-icons/font/fonts/bootstrap-icons.woff2"],
    ["fonts/bootstrap-icons.woff", "bootstrap-icons/font/fonts/bootstrap-icons.woff"],
    // The icon stylesheet loads "fonts/…" relative to itself, i.e. /css/fonts/.
    ["css/fonts/bootstrap-icons.woff2", "bootstrap-icons/font/fonts/bootstrap-icons.woff2"],
    ["css/fonts/bootstrap-icons.woff", "bootstrap-icons/font/fonts/bootstrap-icons.woff"],
    // Landing page type: Caveat Brush for headlines, Karla for text (Latin subset).
    ["fonts/caveat-brush-400.woff2", "@fontsource/caveat-brush/files/caveat-brush-latin-400-normal.woff2"],
    ["fonts/karla-400.woff2", "@fontsource/karla/files/karla-latin-400-normal.woff2"],
    ["fonts/karla-600.woff2", "@fontsource/karla/files/karla-latin-600-normal.woff2"],
    ["fonts/karla-800.woff2", "@fontsource/karla/files/karla-latin-800-normal.woff2"],
    // Read-only PPTX renderer for the slide viewer and list thumbnails.
    ["vendor/pptx-renderer/aiden0z-pptx-renderer.browser.es.js", "@aiden0z/pptx-renderer/dist/aiden0z-pptx-renderer.browser.es.js"],
];

for (const dir of ["images", "fonts", "css", "css/fonts", "vendor/pptx-renderer"]) mkdirSync(join(pub, dir), { recursive: true });

let copied = 0;
function link(linkPath: string, target: string): void {
    if (!existsSync(target)) throw new Error(`${target} is missing; run \`bun install\` first`);
    rmSync(linkPath, { recursive: true, force: true });
    try {
        symlinkSync(relative(dirname(linkPath), target), linkPath, "file");
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
        copyFileSync(target, linkPath);
        copied++;
    }
}

for (const [name, target] of files) link(join(pub, name), join(modules, target));

const kind = (p: string) => (lstatSync(p).isSymbolicLink() ? "link" : "copy");
for (const [name] of files) console.log(`public/${name} (${kind(join(pub, name))})`);
if (copied) console.warn(`Symlinks aren't permitted here, so ${copied} item(s) were copied; re-run \`bun run vendor\` after upgrading Bootstrap.`);
