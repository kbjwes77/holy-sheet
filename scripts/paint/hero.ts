// The landing hero: a sailboat heeling through a wake under a swept ultramarine sky, copy space on the left.
import { C, along, clamp, fbm, lerp, mix, samplePath, sstep, sweep, type Painting, type Pt, type Rgb } from "./engine";

const HZ = 830; // horizon

// Boat placement: the mobile crop shows roughly x 1330–2070, so the boat and wake live there.
const SAIL_TIP: Pt = [1530, 190];
const sailInner: Pt[] = [SAIL_TIP, [1590, 400], [1650, 610], [1705, 800]];
const sailOuter: Pt[] = [SAIL_TIP, [1790, 290], [1955, 500], [1950, 680], [1880, 800]];
const hull: Pt[] = [[1300, 842], [1460, 868], [1660, 878], [1860, 866], [2040, 830]];

export const hero = {
    file: "hero-painting.jpg",
    width: 2400,
    height: 1400,
    seed: 42,
    paint(p: Painting): void {
        const { stroke, range, pick, chance, rnd } = p;

        p.fill((sx, sy) => {
            const n = fbm(sx / 300, sy / 300, 21, 3) - 0.5;
            let c: Rgb;
            if (sy < HZ) {
                const t = sy / HZ;
                c = mix(C.navy, C.cobalt, clamp(t * 0.9 + n));
                c = mix(c, C.sky, clamp(sstep(0.35, 1, sx / 2400) * t * 0.7 + n * 0.5));
            } else {
                const t = (sy - HZ) / (1400 - HZ);
                c = mix(C.aqua, C.turq, clamp(t * 2 + n));
                c = mix(c, C.cobalt, clamp((t - 0.45) * 1.3 + n));
            }
            return c;
        });

        // ---- sky
        // Broad ultramarine-to-cobalt knife and brush swipes rising to the upper right, darkest behind the copy.
        for (let k = 0; k < 190; k++) {
            const x = range(-400, 2400), y = range(-120, HZ - 30);
            const dark = clamp(0.62 * (1 - y / HZ) + 0.45 * (1 - x / 2400) + range(-0.25, 0.25));
            const colors =
                dark > 0.75 ? [C.ink, C.navy, C.ultra] : dark > 0.5 ? [C.navy, C.ultra, C.cobalt] : dark > 0.3 ? [C.ultra, C.cobalt, C.royal] : [C.cobalt, C.royal, C.sky];
            stroke({
                path: sweep([x, y], range(-30, -8), range(500, 1100), range(-160, 120)),
                width: range(90, 230),
                colors: rnd() < 0.5 ? colors : [...colors].reverse(),
                mixing: range(0.2, 0.6),
                load: range(0.95, 1.35),
                reach: range(600, 1300),
                pickup: 0.05,
                thick: 0.4,
                knife: chance(0.45),
                wobble: 10,
            });
        }
        // Deep ultramarine dashes like the reference's upper sky.
        for (let k = 0; k < 26; k++) {
            stroke({
                path: sweep([range(1200, 2500), range(-40, 420)], range(-25, -5), range(160, 420), range(-50, 50)),
                width: range(30, 80),
                colors: [C.ultra, C.navy],
                load: range(1, 1.3),
                reach: 500,
                knife: true,
                thick: 0.6,
            });
        }
        // Curving pale knife swipes: dry and half-translucent, so they break up and let the blue through.
        // Few and dim on the left, where the copy sits.
        for (let k = 0; k < 40; k++) {
            const x = 2400 - Math.pow(rnd(), 1.3) * 2700;
            const y = range(-60, HZ - 60);
            const left = x < 1000;
            if (left && chance(0.6)) continue;
            stroke({
                path: sweep([x, y], range(-34, -6), range(500, 1150), range(-200, 120)),
                width: range(30, 110),
                colors: left ? [C.royal, C.sky] : pick([[C.sky, C.pale, C.royal], [C.pale, C.sky], [C.sky, C.pale, C.aqua], [C.royal, C.pale, C.white]]),
                mixing: 0.5,
                load: range(0.6, 0.95),
                reach: range(450, 900),
                pickup: 0.1,
                thick: 0.65,
                opacity: range(0.5, 0.75),
                knife: chance(0.6),
                wobble: 12,
            });
        }
        // Horizon glow: long, thin and broken.
        for (let k = 0; k < 14; k++) {
            const y = HZ + range(-30, 14);
            stroke({
                path: [[range(-100, 600), y + range(-8, 8)], [1000, y + range(-6, 6)], [1700, y + range(-6, 6)], [range(2100, 2500), y + range(-8, 8)]],
                width: range(14, 36),
                colors: pick([[C.white, C.pale], [C.aqua, C.white], [C.pale, C.sky]]),
                load: range(0.6, 0.9),
                reach: range(900, 2000),
                knife: true,
                thick: 0.7,
                wobble: 4,
            });
        }

        // ---- water
        // Near-horizontal knife sweeps: aqua and turquoise near the horizon, deepening to cobalt at the bottom.
        for (let k = 0; k < 240; k++) {
            const y = HZ + Math.pow(rnd(), 0.9) * (1400 - HZ + 80);
            const depth = clamp((y - HZ) / (1400 - HZ) + range(-0.2, 0.2));
            const colors =
                depth < 0.15 ? [C.aqua, C.pale, C.turq] : depth < 0.4 ? [C.turq, C.sea, C.aqua, C.royal] : depth < 0.65 ? [C.teal, C.royal, C.turq, C.cobalt] : [C.cobalt, C.ultra, C.teal, C.navy];
            stroke({
                path: sweep([range(-500, 2300), y], range(-6, 5), range(500, 1300), range(-40, 60)),
                width: range(45, 150),
                colors,
                mixing: range(0.3, 0.8),
                load: range(1, 1.35),
                reach: range(700, 1500),
                pickup: 0.06,
                thick: 0.45,
                knife: chance(0.6),
                wobble: 8,
            });
        }
        // Dry white and mint highlights skimming the surface.
        for (let k = 0; k < 110; k++) {
            const x = range(-300, 2400);
            const y = HZ + 20 + Math.pow(rnd(), 1.3) * (1400 - HZ);
            if (x < 900 && chance(0.4)) continue;
            stroke({
                path: sweep([x, y], range(-5, 4), range(250, 800), range(-30, 30)),
                width: range(12, 55),
                colors: pick([[C.white, C.aqua], [C.mint, C.white], [C.pale, C.white, C.aqua]]),
                load: range(0.5, 0.85),
                reach: range(250, 600),
                pickup: 0.05,
                thick: 0.9,
                knife: chance(0.5),
            });
        }

        // ---- wake
        // The big arc swept under the boat, like the bottom of a circle, with a cobalt shadow edge.
        for (let k = 0; k < 9; k++) {
            const o = k * 26 + range(-10, 10);
            stroke({
                path: [[1240 - o * 0.3, 900 + o * 0.2], [1420, 1060 + o], [1750, 1150 + o * 0.9], [2100, 1080 + o * 0.6], [2460, 900 + o * 0.4]],
                width: range(55, 95),
                colors: k < 3 ? [C.white, C.pale, C.aqua] : k < 6 ? [C.aqua, C.turq, C.white] : [C.turq, C.teal, C.sky],
                mixing: 0.5,
                load: range(1.05, 1.3),
                reach: range(800, 1300),
                pickup: 0.08,
                thick: 0.9,
                knife: true,
                wobble: 10,
            });
        }
        stroke({ path: [[1300, 1000], [1520, 1230], [1850, 1310], [2200, 1240], [2480, 1060]], width: 46, colors: [C.cobalt, C.ultra], load: 1.25, reach: 1400, knife: true, thick: 0.8 });
        // The sail's gesture carried down through the hull into the wake.
        stroke({ path: [[1890, 430], [1960, 640], [1900, 900], [1700, 1070], [1440, 1110]], width: 54, colors: [C.white, C.aqua, C.mint], load: 1.05, reach: 1000, knife: true, thick: 1, pickup: 0.05 });

        // ---- sail
        // Strokes run the length of the crescent: sun yellow on the luff, white through the belly, green on the leech.
        const bands = 15;
        for (let k = 0; k < bands; k++) {
            const s = clamp(k / (bands - 1) + range(-0.04, 0.04));
            const ctrl: Pt[] = [0, 0.22, 0.45, 0.7, 1].map((u) => {
                const a = along(sailInner, u), b = along(sailOuter, u);
                return [lerp(a[0], b[0], s) + range(-8, 8), lerp(a[1], b[1], s) + range(-8, 8)] as Pt;
            });
            const colors =
                s < 0.22 ? [C.sunDeep, C.sun, C.lemon] : s < 0.4 ? [C.sun, C.lemon, C.cream] : s < 0.78 ? [C.white, C.cream, C.pale] : s < 0.9 ? [C.white, C.aqua, C.mint] : [C.mint, C.lime, C.sap];
            stroke({
                path: chance(0.35) ? ctrl.reverse() : ctrl,
                width: range(46, 70),
                colors,
                mixing: 0.45,
                load: range(1.1, 1.4),
                reach: range(650, 1000),
                pickup: 0.04,
                thick: 1,
                knife: chance(0.55),
                wobble: 5,
            });
        }
        // Dry yellow scumbles in the upper luff.
        for (let k = 0; k < 10; k++) {
            const a = along(sailInner, range(0.1, 0.6)), b = along(sailOuter, range(0.1, 0.5));
            const s = range(0.05, 0.35);
            stroke({
                path: sweep([lerp(a[0], b[0], s), lerp(a[1], b[1], s)], range(55, 80), range(90, 220), range(-20, 20), 4),
                width: range(22, 46),
                colors: [C.sun, C.lemon, C.sunDeep],
                load: range(0.45, 0.7),
                reach: 260,
                thick: 0.9,
            });
        }
        // A bright impasto ridge down the belly and a lime line along the leech.
        const across = (s: number, us: number[]) => us.map((u) => {
            const a = along(sailInner, u), b = along(sailOuter, u);
            return [lerp(a[0], b[0], s), lerp(a[1], b[1], s)] as Pt;
        });
        stroke({ path: across(0.62, [0.02, 0.3, 0.6, 0.95]), width: 30, colors: [C.white, C.cream], load: 1.3, reach: 900, knife: true, thick: 1.6 });
        stroke({ path: across(0.96, [0.05, 0.35, 0.65, 0.92]), width: 14, colors: [C.lime, C.sap, C.mint], load: 0.85, reach: 700, thick: 0.8 });

        // ---- hull
        stroke({ path: hull, width: 84, colors: [C.ink, C.navy, C.ink], mixing: 0.6, load: 1.6, reach: 3000, pickup: 0.01, thick: 1, wobble: 3, taper: [0.05, 0.12] });
        stroke({ path: hull.map(([x, y]) => [x + 30, y + 22] as Pt), width: 40, colors: [C.ink, C.navy], load: 1.5, reach: 3000, pickup: 0.01, knife: true, thick: 0.8, wobble: 3 });
        // Gunwale catching the sun.
        stroke({ path: hull.map(([x, y], i) => [x + (i === 0 ? 30 : 0), y - 30 + (i === 0 ? 6 : 0)] as Pt), width: 11, colors: [C.sun, C.cream, C.white], load: 1.1, reach: 1200, knife: true, thick: 1.2, wobble: 2 });
        // Boom.
        stroke({ path: [[1690, 806], [1800, 800], [1890, 796]], width: 9, colors: [C.ink], load: 1.2, reach: 400, thick: 0.6, wobble: 1 });

        // ---- foam
        // Churning white knife strokes under the hull that drag its navy into the foam.
        for (let k = 0; k < 28; k++) {
            const x = range(1230, 2050), y = range(930, 1010);
            stroke({
                path: sweep([x, y], range(-10, 14) + (chance(0.4) ? 180 : 0), range(150, 420), range(-50, 50), 4),
                width: range(20, 50),
                colors: pick([[C.white, C.pale], [C.white, C.aqua], [C.cream, C.white]]),
                load: range(0.8, 1.2),
                reach: range(150, 320),
                pickup: range(0.1, 0.22),
                thick: 1.2,
                knife: chance(0.7),
            });
        }
        // Sail and hull reflections: short, dry, mostly vertical.
        for (let k = 0; k < 12; k++) {
            const x = range(1480, 1920), y = range(895, 950);
            stroke({
                path: sweep([x, y], range(84, 96), range(50, 120), range(-6, 6), 3),
                width: range(12, 22),
                colors: chance(0.65) ? [C.sun, C.lemon] : [C.navy, C.ink],
                load: range(0.55, 0.85),
                reach: 120,
                thick: 0.7,
            });
        }
        // Small impasto glints.
        for (let k = 0; k < 12; k++) {
            const x = range(1250, 2300), y = range(HZ + 20, 1100);
            stroke({ path: sweep([x, y], range(-12, 8), range(60, 150), range(-10, 10), 3), width: range(10, 24), colors: [C.white, C.cream], load: 1.2, reach: 200, thick: 1.5 });
        }

        // ---- spray
        // Thin, dry flicks thrown up and back off the bow, the waterline and the wake crest.
        const sources: Pt[] = [
            ...Array.from({ length: 6 }, (_, i) => [1300 + i * 30, 880 - i * 4] as Pt), // bow
            ...samplePath(hull, 60).map(([x, y]) => [x, y + 40] as Pt), // waterline
            ...samplePath([[1420, 1060], [1750, 1150], [2100, 1080], [2460, 900]], 70), // wake crest
        ];
        for (let k = 0; k < 70; k++) {
            const [sx, sy] = pick(sources);
            const bow = sx < 1500;
            stroke({
                path: sweep([sx + range(-40, 40), sy + range(-15, 20)], bow ? range(-160, -110) : range(-150, -30), range(40, 150), range(-25, 25), 4),
                width: range(5, 16),
                colors: pick([[C.white, C.pale], [C.pale, C.aqua], [C.white, C.aqua, C.mint]]),
                mixing: 0.6,
                load: range(0.45, 0.75),
                reach: range(80, 180),
                pickup: 0.08,
                thick: 0.9,
                opacity: range(0.55, 0.85),
                taper: [0.05, 0.6],
                wobble: 3,
            });
        }
        // A faint mist of tiny dry dabs over the spray, and a few far off on the swell.
        for (let k = 0; k < 60; k++) {
            const near = k < 40;
            const [sx, sy] = near ? pick(sources) : [range(200, 2400), range(HZ + 60, 1350)];
            stroke({
                path: sweep([sx + range(-80, 80), sy - (near ? range(10, 90) : 0)], range(-40, 10), range(14, 40), 0, 3),
                width: range(4, 10),
                colors: [C.white, C.pale],
                load: range(0.4, 0.7),
                reach: 60,
                thick: 0.6,
                opacity: near ? 0.7 : 0.45,
            });
        }
    },
};
