// The landing page's other paintings: the "How it works" boat and water, the closing fleet and the fleet strip.
import { C, along, clamp, fbm, lerp, mix, sweep, type Painting, type Pt, type Rgb } from "./engine";

/** Long near-horizontal water sweeps between y0 and y1; `colorsAt` picks a load by depth (0 top … 1 bottom). */
function water(p: Painting, o: { count: number; y0: number; y1: number; width: number; colorsAt: (depth: number) => Rgb[]; widths: [number, number] }): void {
    const { stroke, range, chance } = p;
    for (let k = 0; k < o.count; k++) {
        const y = range(o.y0 - 40, o.y1 + 40);
        const depth = clamp((y - o.y0) / (o.y1 - o.y0) + range(-0.15, 0.15));
        stroke({
            path: sweep([range(-500, o.width - 200), y], range(-4, 4), range(500, 1300), range(-40, 50)),
            width: range(...o.widths),
            colors: o.colorsAt(depth),
            mixing: range(0.3, 0.8),
            load: range(1, 1.35),
            reach: range(700, 1500),
            pickup: 0.06,
            thick: 0.45,
            knife: chance(0.6),
            wobble: 8,
        });
    }
}

/**
 * A small dinghy sitting on the water at (x, y): fanned knife strokes for the sail with ink edges and a few
 * colored dashes (an answer sheet's lines), a colored hull and a couple of dry wake flicks. `s` is the sail height.
 */
function dinghy(p: Painting, x: number, y: number, s: number, flip = false): void {
    const { stroke, range, pick } = p;
    const d = flip ? -1 : 1;
    const foot = y - 0.13 * s;
    const tip: Pt = [x + d * 0.04 * s, y - s];
    const luffFoot: Pt = [x - d * 0.02 * s, foot];
    const clew: Pt = [x + d * 0.6 * s, foot];
    const thin = Math.max(2, 0.035 * s);

    // Sail: strokes from the head fanning down to points along the foot, with a little belly to leeward.
    for (let k = 0; k < 5; k++) {
        const f = (k + 0.5) / 5;
        const end: Pt = [lerp(luffFoot[0], clew[0], f), foot + range(-0.02, 0.02) * s];
        const mid: Pt = [lerp(tip[0], end[0], 0.55) + d * 0.06 * s * f, lerp(tip[1], end[1], 0.55)];
        stroke({ path: [tip, mid, end], width: 0.17 * s, colors: pick([[C.white, C.cream], [C.white, C.pale], [C.cream, C.white]]), load: 1.3, reach: 4 * s, knife: true, thick: 0.9, pickup: 0.02, wobble: 0.01 * s, taper: [0.02, 0.05] });
    }
    // Ink edges: up the luff and down the leech.
    stroke({ path: [luffFoot, [lerp(luffFoot[0], tip[0], 0.5) - d * 0.015 * s, lerp(luffFoot[1], tip[1], 0.5)], tip], width: thin, colors: [C.ink], load: 1.4, reach: 5 * s, thick: 0.8, wobble: 0.01 * s, taper: [0.02, 0.1] });
    stroke({ path: [tip, [lerp(tip[0], clew[0], 0.5) + d * 0.06 * s, lerp(tip[1], clew[1], 0.5)], clew], width: thin * 0.8, colors: [C.ink, C.navy], load: 1.1, reach: 3 * s, thick: 0.7, wobble: 0.01 * s });
    // Answer-sheet dashes across the sail.
    for (let k = 0; k < 3; k++) {
        const f = 0.25 + k * 0.2 + range(-0.03, 0.03);
        const yy = lerp(foot, tip[1], f);
        const span = 0.6 * s * (1 - f);
        const x0 = lerp(luffFoot[0], tip[0], f) + d * span * 0.18;
        stroke({ path: [[x0, yy], [x0 + d * span * range(0.3, 0.5), yy + range(-0.01, 0.01) * s]], width: Math.max(2, 0.032 * s), colors: [pick([C.cobalt, C.sea, C.sun, C.coral, C.ink])], load: 1.2, reach: s, thick: 0.6, wobble: 0, taper: [0.1, 0.3] });
    }
    // Hull, with an ink waterline underneath.
    const hullColor = pick([C.coral, C.orange, C.sun, C.cobalt, C.coral]);
    const bow: Pt = [x - d * 0.13 * s, foot + 0.02 * s], stern: Pt = [x + d * 0.7 * s, foot - 0.01 * s];
    stroke({ path: [bow, [x + d * 0.25 * s, foot + 0.07 * s], stern], width: 0.13 * s, colors: [hullColor, mix(hullColor, C.ink, 0.2)], load: 1.4, reach: 4 * s, knife: true, thick: 1, wobble: 0.005 * s, taper: [0.01, 0.04] });
    stroke({ path: [[bow[0] + d * 0.06 * s, y - 0.01 * s], [x + d * 0.25 * s, y + 0.005 * s], [stern[0] - d * 0.05 * s, y - 0.02 * s]], width: thin * 0.8, colors: [C.ink], load: 1.1, reach: 3 * s, thick: 0.6, wobble: 0 });
    // Wake: dry flicks trailing astern.
    for (let k = 0; k < 3; k++) {
        const wy = y + 0.04 * s + k * 0.05 * s;
        stroke({ path: sweep([stern[0] - d * 0.1 * s + d * k * 0.06 * s, wy], flip ? 180 + range(-4, 4) : range(-4, 4), range(0.35, 0.6) * s, 0, 3), width: Math.max(2.5, 0.04 * s), colors: [C.white, C.pale], load: range(0.6, 0.9), reach: 0.5 * s, thick: 0.6, opacity: 0.8, wobble: 0 });
    }
}

// ---- How it works: a painted boat on a transparent canvas, beside the steps ----------------------------------

const B = {
    sailInner: [[330, 70], [390, 270], [455, 470], [505, 660]] as Pt[],
    sailOuter: [[330, 70], [560, 140], [725, 330], [740, 510], [670, 655]] as Pt[],
    hull: [[140, 655], [300, 693], [480, 708], [660, 692], [825, 615]] as Pt[],
};

export const boat = {
    file: "boat-painting.png",
    width: 1000,
    height: 1020,
    seed: 3,
    transparent: true,
    paint(p: Painting): void {
        const { stroke, range, pick, chance } = p;
        const across = (s: number, us: number[]) => us.map((u) => {
            const a = along(B.sailInner, u), b = along(B.sailOuter, u);
            return [lerp(a[0], b[0], s), lerp(a[1], b[1], s)] as Pt;
        });

        // The water: a white-and-aqua foam band under the hull, then a deeper blue swell.
        for (let k = 0; k < 7; k++) {
            const o = k * 11 + range(-5, 5);
            stroke({ path: [[95 + o * 0.4, 735 + o * 0.3], [350, 760 + o], [650, 755 + o], [930, 705 + o * 0.5]], width: range(28, 46), colors: k < 4 ? [C.white, C.pale, C.aqua] : [C.aqua, C.turq, C.white], mixing: 0.5, load: range(1.05, 1.3), reach: range(700, 1000), pickup: 0.08, thick: 0.9, knife: true, wobble: 6 });
        }
        for (let k = 0; k < 8; k++) {
            const o = k * 12 + range(-5, 5);
            stroke({ path: [[30 + o * 0.3, 815 + o * 0.4], [350, 870 + o * 0.8], [700, 860 + o * 0.7], [985, 790 + o * 0.4]], width: range(30, 50), colors: k < 3 ? [C.sky, C.turq, C.aqua] : k < 6 ? [C.turq, C.royal, C.sky] : [C.cobalt, C.royal, C.ultra], mixing: 0.5, load: range(1.05, 1.3), reach: range(800, 1100), pickup: 0.08, thick: 0.9, knife: true, wobble: 6 });
        }
        // Dry white highlights across both bands.
        for (let k = 0; k < 14; k++) {
            stroke({ path: sweep([range(80, 700), range(770, 900)], range(-6, 4), range(120, 320), range(-15, 15), 4), width: range(8, 22), colors: pick([[C.white, C.aqua], [C.white, C.pale]]), load: range(0.5, 0.8), reach: range(150, 300), thick: 0.9, knife: chance(0.5) });
        }

        // The sail, as in the hero: sun on the luff, white through the belly, green on the leech.
        const bands = 13;
        for (let k = 0; k < bands; k++) {
            const s = clamp(k / (bands - 1) + range(-0.04, 0.04));
            const ctrl: Pt[] = [0, 0.22, 0.45, 0.7, 1].map((u) => {
                const a = along(B.sailInner, u), b = along(B.sailOuter, u);
                return [lerp(a[0], b[0], s) + range(-5, 5), lerp(a[1], b[1], s) + range(-5, 5)] as Pt;
            });
            const colors =
                s < 0.22 ? [C.sunDeep, C.sun, C.lemon] : s < 0.4 ? [C.sun, C.lemon, C.cream] : s < 0.78 ? [C.white, C.cream, C.pale] : s < 0.9 ? [C.white, C.aqua, C.mint] : [C.mint, C.lime, C.sap];
            stroke({ path: chance(0.35) ? ctrl.reverse() : ctrl, width: range(40, 58), colors, mixing: 0.45, load: range(1.15, 1.45), reach: range(550, 800), pickup: 0.04, thick: 1, knife: chance(0.55), wobble: 4 });
        }
        for (let k = 0; k < 8; k++) {
            const a = along(B.sailInner, range(0.1, 0.6)), b = along(B.sailOuter, range(0.1, 0.5));
            const s = range(0.05, 0.35);
            stroke({ path: sweep([lerp(a[0], b[0], s), lerp(a[1], b[1], s)], range(55, 80), range(70, 170), range(-15, 15), 4), width: range(18, 36), colors: [C.sun, C.lemon, C.sunDeep], load: range(0.45, 0.7), reach: 200, thick: 0.9 });
        }
        stroke({ path: across(0.62, [0.02, 0.3, 0.6, 0.95]), width: 24, colors: [C.white, C.cream], load: 1.3, reach: 700, knife: true, thick: 1.6 });
        stroke({ path: across(0.97, [0.04, 0.35, 0.65, 0.93]), width: 12, colors: [C.lime, C.sap, C.mint], load: 0.9, reach: 600, thick: 0.8 });
        stroke({ path: [[495, 630], [580, 626], [655, 622]], width: 8, colors: [C.ink], load: 1.2, reach: 300, thick: 0.6, wobble: 1 });

        // Hull, its underside, and the gunwale catching the sun.
        stroke({ path: B.hull, width: 76, colors: [C.ink, C.navy, C.ink], mixing: 0.6, load: 1.6, reach: 2500, pickup: 0.01, thick: 1, wobble: 3, taper: [0.05, 0.12] });
        stroke({ path: B.hull.map(([x, y]) => [x + 25, y + 20] as Pt), width: 34, colors: [C.ink, C.navy], load: 1.5, reach: 2500, pickup: 0.01, knife: true, thick: 0.8, wobble: 3 });
        stroke({ path: B.hull.map(([x, y], i) => [x + (i === 0 ? 25 : 0), y - 27 + (i === 0 ? 5 : 0)] as Pt), width: 10, colors: [C.sun, C.cream, C.white], load: 1.1, reach: 1000, knife: true, thick: 1.2, wobble: 2 });

        // Reflections and spray off the bow.
        for (let k = 0; k < 10; k++) {
            stroke({ path: sweep([range(300, 660), range(738, 760)], range(84, 96), range(30, 80), range(-5, 5), 3), width: range(9, 16), colors: chance(0.65) ? [C.sun, C.lemon] : [C.navy, C.ink], load: range(0.6, 0.9), reach: 90, thick: 0.7 });
        }
        for (let k = 0; k < 30; k++) {
            const bow = k < 14;
            const [sx, sy]: Pt = bow ? [range(100, 220), range(680, 740)] : [range(250, 900), range(735, 780)];
            stroke({ path: sweep([sx, sy], bow ? range(-170, -120) : range(-150, -30), range(25, 90), range(-15, 15), 4), width: range(4, 11), colors: pick([[C.white, C.pale], [C.pale, C.aqua]]), mixing: 0.6, load: range(0.5, 0.8), reach: range(50, 110), thick: 0.9, opacity: range(0.6, 0.9), taper: [0.05, 0.6], wobble: 2 });
        }
    },
};

// ---- How it works: the deep water behind the steps --------------------------------------------------------------

export const how = {
    file: "how-bg.jpg",
    width: 2400,
    height: 1000,
    seed: 5,
    paint(p: Painting): void {
        const { stroke, range, pick, chance } = p;
        p.fill((x, y) => mix(C.navy, C.cobalt, clamp(0.5 + (fbm(x / 400, y / 250, 31, 3) - 0.5) * 2)));
        water(p, {
            count: 230,
            y0: 0,
            y1: 1000,
            width: 2400,
            widths: [60, 200],
            colorsAt: () => pick([[C.navy, C.ultra, C.cobalt], [C.ultra, C.cobalt, C.royal], [C.cobalt, C.navy], [C.ink, C.navy, C.ultra], [C.royal, C.cobalt, C.ultra]]),
        });
        // Long teal and turquoise currents.
        for (let k = 0; k < 16; k++) {
            stroke({ path: sweep([range(-400, 1900), range(60, 940)], range(-3, 2), range(700, 1400), range(-30, 30)), width: range(30, 80), colors: pick([[C.teal, C.turq, C.sea], [C.turq, C.sky, C.teal], [C.sea, C.aqua, C.teal]]), mixing: 0.6, load: range(0.9, 1.2), reach: range(600, 1100), pickup: 0.12, thick: 0.6, knife: chance(0.6), wobble: 8 });
        }
        // Faint dry glints.
        for (let k = 0; k < 45; k++) {
            stroke({ path: sweep([range(-200, 2400), range(0, 1000)], range(-4, 3), range(200, 600), range(-20, 20)), width: range(10, 40), colors: pick([[C.sky, C.pale], [C.royal, C.sky], [C.aqua, C.sky]]), load: range(0.45, 0.75), reach: range(200, 450), pickup: 0.1, thick: 0.8, opacity: range(0.45, 0.7), knife: chance(0.5) });
        }
    },
};

// ---- Closing: a fleet of dinghies on bright water, open space up top for the headline ----------------------------

export const closing = {
    file: "closing-fleet.jpg",
    width: 2400,
    height: 900,
    seed: 11,
    paint(p: Painting): void {
        const { stroke, range, pick, chance } = p;
        p.fill((x, y) => {
            const t = clamp(y / 900 + (fbm(x / 350, y / 200, 41, 3) - 0.5) * 0.5);
            return t < 0.45 ? mix(C.cobalt, C.royal, t / 0.45) : mix(C.royal, C.turq, (t - 0.45) / 0.55);
        });
        water(p, {
            count: 260,
            y0: 0,
            y1: 900,
            width: 2400,
            widths: [45, 150],
            colorsAt: (d) => (d < 0.25 ? [C.ultra, C.cobalt, C.royal] : d < 0.5 ? [C.cobalt, C.royal, C.sky, C.turq] : d < 0.75 ? [C.royal, C.turq, C.sea, C.sky] : [C.turq, C.sea, C.aqua, C.teal]),
        });
        for (let k = 0; k < 90; k++) {
            const y = 120 + Math.pow(p.rnd(), 0.8) * 800;
            const x = range(-300, 2400);
            if (y < 420 && x > 400 && x < 1800) continue; // keep the headline's water calm
            stroke({ path: sweep([x, y], range(-4, 3), range(200, 650), range(-20, 20)), width: range(10, 45), colors: pick([[C.white, C.aqua], [C.mint, C.white], [C.pale, C.white, C.aqua]]), load: range(0.45, 0.8), reach: range(200, 500), pickup: 0.06, thick: 0.9, opacity: range(0.55, 0.85), knife: chance(0.5) });
        }

        // Rows recede toward the top; the far rows keep to the edges so the headline sits on open water.
        const rows: [y: number, size: number, xs: number[]][] = [
            [150, 44, [120, 2210]],
            [260, 50, [300, 2060, 2330]],
            [395, 58, [40, 390, 2010, 2340]],
            [520, 66, Array.from({ length: 9 }, (_, i) => 120 + i * 275)],
            [655, 76, Array.from({ length: 8 }, (_, i) => 230 + i * 300)],
            [810, 88, Array.from({ length: 8 }, (_, i) => 90 + i * 315)],
        ];
        for (const [y, size, xs] of rows) {
            for (const x of xs) dinghy(p, x + range(-50, 50), y + range(-18, 18), size * range(0.9, 1.1), chance(0.2));
        }
    },
};

// ---- The strip under the hero: a line of dinghies on a transparent band ---------------------------------------

export const strip = {
    file: "fleet-strip.png",
    width: 2400,
    height: 190,
    seed: 13,
    transparent: true,
    paint(p: Painting): void {
        const { range, chance } = p;
        // The strip is shown 132px tall from the top, so everything stays above y ≈ 150.
        for (let k = 0; k < 12; k++) dinghy(p, 40 + k * 200 + range(-25, 25), range(95, 125), range(62, 86), chance(0.15));
    },
};
