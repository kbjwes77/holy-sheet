// Renders the social card (scripts/og-card.html) to public/images/og-image.jpg with headless Chrome:
//   bun scripts/render-og.ts
// Re-run it after repainting the hero (bun scripts/paint.ts hero). Set CHROME to the browser binary if it isn't found.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const candidates = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
].filter((c): c is string => !!c);
const chrome = candidates.find((c) => existsSync(c));
if (!chrome) throw new Error("Chrome not found; set CHROME to its path");

const out = resolve(import.meta.dir, "../public/images/og-image.jpg");
const dir = mkdtempSync(join(tmpdir(), "og-"));
const shot = join(dir, "card.png");
try {
    // Chrome won't load fonts across file:// URLs, so inline them; a <base> keeps the image paths working.
    const html = readFileSync(resolve(import.meta.dir, "og-card.html"), "utf8")
        .replace(/url\("(\.\.\/public\/fonts\/[^"]+\.woff2)"\)/g, (_, f: string) => `url("data:font/woff2;base64,${readFileSync(resolve(import.meta.dir, f)).toString("base64")}")`)
        .replace("<head>", `<head><base href="${pathToFileURL(import.meta.dir).href}/" />`);
    const card = join(dir, "card.html");
    writeFileSync(card, html);
    const proc = Bun.spawn(
        [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1200,630", "--virtual-time-budget=5000", `--user-data-dir=${join(dir, "profile")}`, `--screenshot=${shot}`, card],
        { stdout: "ignore", stderr: "pipe" },
    );
    if ((await proc.exited) !== 0 || !existsSync(shot)) throw new Error(`Chrome failed: ${await new Response(proc.stderr).text()}`);
    await sharp(shot).resize(1200, 630, { fit: "cover", position: "left top" }).jpeg({ quality: 88, mozjpeg: true }).toFile(out);
    console.log(`og card → ${out}`);
} finally {
    rmSync(dir, { recursive: true, force: true });
}
