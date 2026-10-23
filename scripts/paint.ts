// Paints the landing page's oil paintings into public/images/ with the bristle engine in scripts/paint/engine.ts.
//   bun scripts/paint.ts                 every painting
//   bun scripts/paint.ts hero boat       just those
//   --seed 7       try another seed (each scene records the seed of its published image)
//   --scale 0.5    render smaller, for quick previews
//   --out dir      write somewhere other than public/images/
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPainting } from "./paint/engine";
import { hero } from "./paint/hero";
import { boat, closing, how, strip } from "./paint/scenes";

const scenes = { hero, boat, how, closing, strip };
type Name = keyof typeof scenes;

const argv = process.argv.slice(2);
const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const seed = flag("seed");
const scale = Number(flag("scale") ?? 1);
const outDir = resolve(flag("out") ?? resolve(import.meta.dir, "../public/images"));
const names = (argv.length ? argv : Object.keys(scenes)) as Name[];
for (const n of names) if (!(n in scenes)) throw new Error(`Unknown painting "${n}"; choose from ${Object.keys(scenes).join(", ")}`);
mkdirSync(outDir, { recursive: true });

for (const name of names) {
    const s = scenes[name];
    const t0 = performance.now();
    const p = createPainting({ width: s.width, height: s.height, seed: seed ? Number(seed) : s.seed, scale, transparent: "transparent" in s && s.transparent });
    s.paint(p);
    const out = join(outDir, seed ? s.file.replace(/(\.\w+)$/, `-seed${seed}$1`) : s.file);
    await p.save(out);
    console.log(`${name}: ${out} (${p.W}×${p.H}, ${((performance.now() - t0) / 1000).toFixed(1)}s)`);
}
