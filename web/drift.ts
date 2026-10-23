// Floating line-art boats for the landing page's calm divider.
// Four boats, three hand-drawn frames each. The frames cycle like a flip-book, the boats drift across their layer, steer
// away from the pointer and heel over as they go, and a click or tap sends a gust through the ones nearby.
// With prefers-reduced-motion the boats are drawn once and stay still.

type P = [number, number];
type Role = "hull" | "rig" | "sail" | "water" | "flag";
type Stroke = { role: Role; pts: P[]; closed?: boolean; thin?: boolean };

const NS = "http://www.w3.org/2000/svg";
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// Geometry helpers. Every boat lives in a 120 x 120 box with the waterline at y = 84.
const bez = (a: P, b: P, c: P, d: P, n = 12): P[] =>
    Array.from({ length: n + 1 }, (_, i) => {
        const t = i / n, u = 1 - t;
        return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]] as P;
    });
const ln = (a: P, b: P, n = 5): P[] => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as P);
const rot = (pts: P[], pv: P, deg: number): P[] => {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    return pts.map(([x, y]) => [pv[0] + (x - pv[0]) * c - (y - pv[1]) * s, pv[1] + (x - pv[0]) * s + (y - pv[1]) * c] as P);
};
const mv = (pts: P[], dx: number, dy: number): P[] => pts.map(([x, y]) => [x + dx, y + dy] as P);
const wave = (x0: number, x1: number, y: number, amp: number, ph: number): P[] => {
    const out: P[] = [];
    for (let x = x0; x <= x1; x += 4) out.push([x, y + amp * Math.sin(x / 9 + ph)]);
    return out;
};

const SWAY = [-2.2, 0, 2.2], BOB = [0, -1.6, 0.9];

/** The strokes of boat `b` in frame `f`. */
const BOATS: ((f: number) => Stroke[])[] = [
    // dinghy
    (f) => {
        const pv: P = [58, 80], S = (p: P[]) => mv(rot(p, pv, (SWAY[f] ?? 0)), 0, (BOB[f] ?? 0)), H = (p: P[]) => mv(p, 0, (BOB[f] ?? 0));
        return [
            { role: "sail", closed: true, pts: S([...bez([59, 17], [90, 34], [90, 60], [61, 76]), ...ln([61, 76], [59, 17], 3)]) },
            { role: "sail", thin: true, pts: S(ln([64, 36], [80, 38], 3)) }, { role: "sail", thin: true, pts: S(ln([64, 50], [83, 52], 3)) }, { role: "sail", thin: true, pts: S(ln([62, 63], [77, 65], 3)) },
            { role: "hull", pts: S(ln([58, 14], [58, 80], 8)) },
            { role: "flag", closed: true, pts: S([[58, 14], [71, 11 + f * 1.6], [58, 19]]) },
            { role: "hull", pts: H(bez([20, 80], [30, 99], [86, 99], [104, 77], 14)) },
            { role: "hull", pts: H(ln([20, 80], [104, 77], 8)) },
            { role: "rig", pts: H(bez([27, 88], [40, 93], [80, 93], [96, 86], 8)) },
            { role: "water", pts: wave(28, 94, 101, 1.9, f * 2.1) }, { role: "water", pts: wave(42, 80, 109, 1.5, f * 2.1 + 1.6) },
        ];
    },
    // sloop
    (f) => {
        const pv: P = [54, 80], S = (p: P[]) => mv(rot(p, pv, (SWAY[f] ?? 0) * 0.9), 0, (BOB[f] ?? 0)), H = (p: P[]) => mv(p, 0, (BOB[f] ?? 0));
        return [
            { role: "sail", closed: true, pts: S([...bez([53, 10], [34, 32], [28, 56], [22, 76]), ...ln([22, 76], [53, 75], 4)]) },
            { role: "sail", thin: true, pts: S(ln([50, 34], [37, 38], 3)) }, { role: "sail", thin: true, pts: S(ln([50, 52], [31, 55], 3)) },
            { role: "sail", closed: true, pts: H([...bez([57, 14], [80, 34], [92, 56], [100, 74]), ...ln([100, 74], [58, 74], 5)]) },
            { role: "sail", thin: true, pts: H(ln([62, 42], [76, 43], 3)) }, { role: "sail", thin: true, pts: H(ln([60, 58], [86, 60], 3)) },
            { role: "hull", pts: H(ln([54, 8], [54, 80], 8)) },
            { role: "flag", closed: true, pts: H([[54, 8], [67, 5 + f * 1.8], [54, 13]]) },
            { role: "rig", pts: H(ln([54, 8], [106, 78], 8)) }, { role: "rig", pts: H(ln([54, 8], [14, 79], 8)) },
            { role: "hull", pts: H(bez([12, 80], [18, 100], [92, 100], [112, 78], 14)) }, { role: "hull", pts: H(ln([12, 80], [112, 78], 9)) },
            { role: "hull", pts: H([[52, 79], [58, 71], [78, 71], [86, 79]]) },
            { role: "water", pts: wave(18, 104, 103, 1.9, f * 2.1) }, { role: "water", pts: wave(36, 88, 111, 1.5, f * 2.1 + 1.6) },
        ];
    },
    // catamaran
    (f) => {
        const pv: P = [60, 76], S = (p: P[]) => mv(rot(p, pv, (SWAY[f] ?? 0)), 0, (BOB[f] ?? 0)), H = (p: P[]) => mv(p, 0, (BOB[f] ?? 0));
        return [
            { role: "sail", closed: true, pts: S([...bez([61, 14], [84, 36], [88, 58], [90, 72]), ...ln([90, 72], [62, 72], 4)]) },
            { role: "sail", thin: true, pts: S(ln([64, 34], [80, 36], 3)) }, { role: "sail", thin: true, pts: S(ln([64, 52], [86, 54], 3)) },
            { role: "sail", closed: true, pts: S([...bez([59, 17], [40, 36], [34, 56], [32, 70]), ...ln([32, 70], [58, 70], 4)]) },
            { role: "hull", pts: S(ln([60, 12], [60, 76], 8)) },
            { role: "flag", closed: true, pts: S([[60, 12], [72, 9 + f * 1.6], [60, 17]]) },
            { role: "hull", pts: H(bez([12, 80], [18, 95], [48, 95], [58, 80], 10)) }, { role: "hull", pts: H(ln([12, 80], [58, 80], 6)) },
            { role: "hull", pts: H(bez([64, 80], [70, 95], [102, 95], [110, 80], 10)) }, { role: "hull", pts: H(ln([64, 80], [110, 80], 6)) },
            { role: "rig", pts: H(ln([34, 80], [86, 80], 6)) }, { role: "rig", pts: H(ln([38, 76], [82, 76], 6)) },
            { role: "water", pts: wave(14, 108, 102, 1.9, f * 2.1) }, { role: "water", pts: wave(34, 88, 110, 1.5, f * 2.1 + 1.6) },
        ];
    },
    // spinnaker boat
    (f) => {
        const pv: P = [50, 80], S = (p: P[]) => mv(rot(p, pv, (SWAY[f] ?? 0) * 0.8), 0, (BOB[f] ?? 0)), H = (p: P[]) => mv(p, 0, (BOB[f] ?? 0));
        const bulge = [0, 3, -2][f] ?? 0;
        return [
            { role: "sail", closed: true, pts: S([...bez([49, 16], [36, 34], [32, 54], [28, 72]), ...ln([28, 72], [49, 72], 4)]) },
            { role: "sail", closed: true, pts: S([...bez([52, 14], [96 + bulge, 8], [114 + bulge, 44], [84, 72]), ...bez([84, 72], [66, 60], [56, 40], [52, 14])]) },
            { role: "sail", thin: true, pts: S(bez([60, 18], [84, 22 + bulge], [98, 42], [88, 62], 8)) }, { role: "sail", thin: true, pts: S(bez([57, 28], [76, 36], [84, 50], [78, 64], 8)) },
            { role: "hull", pts: S(ln([50, 12], [50, 78], 8)) }, { role: "rig", pts: S(ln([50, 60], [84, 70], 5)) },
            { role: "flag", closed: true, pts: S([[50, 12], [63, 9 + f * 1.6], [50, 17]]) },
            { role: "hull", pts: H(bez([16, 80], [22, 98], [84, 98], [104, 80], 14)) }, { role: "hull", pts: H(ln([16, 80], [104, 80], 8)) },
            { role: "rig", pts: H(bez([24, 88], [40, 93], [78, 93], [94, 87], 8)) },
            { role: "water", pts: wave(24, 98, 101, 1.9, f * 2.1) }, { role: "water", pts: wave(40, 82, 109, 1.5, f * 2.1 + 1.6) },
        ];
    },
];
const ACCENTS = ["#19c6e8", "#12a58f", "#f4b63a", "#e2523f"];

/** Smooths a polyline into a quadratic path with a little hand-drawn wobble. */
function pathD(pts: P[], closed: boolean | undefined, r: () => number, amp: number): string {
    const p = pts.map(([x, y]) => [x + (r() - 0.5) * amp, y + (r() - 0.5) * amp] as P);
    const fmt = (q: P) => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
    let d = "M" + fmt(p[0]!);
    for (let i = 1; i < p.length - 1; i++) {
        const q = p[i]!, n = p[i + 1]!;
        d += "Q" + fmt(q) + " " + fmt([(q[0] + n[0]) / 2, (q[1] + n[1]) / 2]);
    }
    d += "L" + fmt(p[p.length - 1]!);
    return d + (closed ? "Z" : "");
}

function symbolMarkup(b: number, f: number): string {
    const r = rng(b * 97 + f * 13 + 5);
    return BOATS[b]!(f)
        .map((s) => {
            const d = pathD(s.pts, s.closed, r, 0.9);
            if (s.role === "sail") return `<path d="${d}" fill="var(--acc)" fill-opacity="${s.thin ? 0 : 0.16}" stroke="var(--acc)" stroke-width="${s.thin ? 1.2 : 2.2}"/>`;
            if (s.role === "flag") return `<path d="${d}" fill="var(--acc)" stroke="var(--acc)" stroke-width="1.4"/>`;
            if (s.role === "water") return `<path d="${d}" stroke="currentColor" stroke-width="1.6" opacity=".55"/>`;
            if (s.role === "rig") return `<path d="${d}" stroke="currentColor" stroke-width="1.1" opacity=".75"/>`;
            return `<path d="${d}" stroke="currentColor" stroke-width="2.4"/>`;
        })
        .join("");
}

/** One hidden <svg> holds all twelve frames as symbols; each boat just points a <use> at the current one. */
function ensureDefs(): void {
    if (document.getElementById("gl-drift-defs")) return;
    const svg = document.createElementNS(NS, "svg");
    svg.id = "gl-drift-defs";
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0";
    let html = "";
    for (let b = 0; b < BOATS.length; b++)
        for (let f = 0; f < 3; f++) html += `<symbol id="gl-b${b}-f${f}" viewBox="0 0 120 120" fill="none" stroke-linecap="round" stroke-linejoin="round">${symbolMarkup(b, f)}</symbol>`;
    svg.innerHTML = html;
    document.body.prepend(svg);
}

type Boat = { type: number; size: number; el: SVGSVGElement; use: SVGUseElement; f: number; next: number; x: number; y: number; homeY: number; vx: number; vy: number; vx0: number; amp: number; ph: number };

export function initDrift(layer: HTMLElement, opts: { count?: number; min?: number; max?: number; seed?: number } = {}): { stop(): void } {
    ensureDefs();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const count = opts.count ?? 6, min = opts.min ?? 70, max = opts.max ?? 112, rand = rng(opts.seed ?? 11);
    let rect = layer.getBoundingClientRect();
    const mouse = { x: -9999, y: -9999 };
    const boats: Boat[] = [];

    for (let i = 0; i < count; i++) {
        const type = i % BOATS.length, size = min + rand() * (max - min);
        const el = document.createElementNS(NS, "svg");
        el.setAttribute("viewBox", "0 0 120 120");
        el.setAttribute("width", String(size));
        el.setAttribute("height", String(size));
        el.setAttribute("class", "drift-boat");
        el.style.setProperty("--acc", ACCENTS[type] ?? "#19c6e8");
        const use = document.createElementNS(NS, "use");
        const f = Math.floor(rand() * 3);
        use.setAttribute("href", `#gl-b${type}-f${f}`);
        el.appendChild(use);
        layer.appendChild(el);
        const y = 0.1 * rect.height + (i / count) * 0.78 * rect.height, vx0 = 7 + rand() * 12;
        boats.push({ type, size, el, use, f, next: 0, x: ((i + rand() * 0.6) / count) * rect.width, y, homeY: y, vx: vx0, vy: 0, vx0, amp: 4 + rand() * 5, ph: rand() * 6.28 });
    }

    const place = (b: Boat, t: number) => {
        const yy = b.y + Math.sin(t * 1.1 + b.ph) * b.amp;
        const tilt = Math.max(-16, Math.min(16, (b.vx - b.vx0) * 0.1)) + Math.sin(t * 0.9 + b.ph) * 2.5;
        b.el.style.transform = `translate3d(${b.x.toFixed(1)}px,${yy.toFixed(1)}px,0) rotate(${tilt.toFixed(1)}deg)`;
    };
    boats.forEach((b) => place(b, 0));
    if (reduced) return { stop() {} };

    const onMove = (e: PointerEvent) => {
        rect = layer.getBoundingClientRect();
        mouse.x = e.clientX - rect.left;
        mouse.y = e.clientY - rect.top;
    };
    const onLeave = () => { mouse.x = mouse.y = -9999; };
    const onDown = (e: PointerEvent) => {
        rect = layer.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        for (const b of boats) {
            const dx = b.x + b.size / 2 - mx, dy = b.y + b.size * 0.6 - my, d = Math.hypot(dx, dy) || 1;
            if (d < 320) {
                const s = (1 - d / 320) * 420;
                b.vx += (dx / d) * s;
                b.vy += (dy / d) * s * 0.6;
                b.next = 0;
            }
        }
    };
    addEventListener("pointermove", onMove, { passive: true });
    addEventListener("pointerdown", onDown, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);

    // Only animate while the layer is on screen and the tab is visible.
    let onScreen = true, last = performance.now(), raf = 0, running = false;
    const R = 190;
    const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        rect = layer.getBoundingClientRect();
        const W = rect.width, H = rect.height, t = now / 1000;
        for (const b of boats) {
            const dx = b.x + b.size / 2 - mouse.x, dy = b.y + b.size * 0.6 - mouse.y, d = Math.hypot(dx, dy);
            if (d < R) {
                const s = Math.pow(1 - d / R, 2) * 1500;
                b.vx += (dx / (d || 1)) * s * dt;
                b.vy += (dy / (d || 1)) * s * dt;
            }
            b.vx += (b.vx0 - b.vx) * 1.1 * dt;
            b.vy += ((b.homeY - b.y) * 0.5 - b.vy) * 1.1 * dt;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            if (b.x > W + 20) {
                b.x = -b.size - 20;
                b.homeY = b.y = Math.max(0, Math.min(H - b.size, 0.06 * H + Math.random() * 0.8 * H));
            }
            if (b.x < -b.size - 160) b.x = W + 20;
            b.y = Math.max(-b.size * 0.3, Math.min(H - b.size * 0.8, b.y));
            if (now >= b.next) {
                b.f = (b.f + 1) % 3;
                b.use.setAttribute("href", `#gl-b${b.type}-f${b.f}`);
                b.next = now + 170 + Math.random() * 70;
            }
            place(b, t);
        }
    };
    const sync = () => {
        const should = onScreen && !document.hidden;
        if (should && !running) { running = true; last = performance.now(); raf = requestAnimationFrame(tick); }
        else if (!should && running) { running = false; cancelAnimationFrame(raf); }
    };
    const io = new IntersectionObserver((entries) => { onScreen = entries[entries.length - 1]?.isIntersecting ?? true; sync(); });
    io.observe(layer);
    document.addEventListener("visibilitychange", sync);
    sync();
    return {
        stop() {
            running = false;
            cancelAnimationFrame(raf);
            io.disconnect();
            removeEventListener("pointermove", onMove);
            removeEventListener("pointerdown", onDown);
            document.documentElement.removeEventListener("pointerleave", onLeave);
            document.removeEventListener("visibilitychange", sync);
        },
    };
}
