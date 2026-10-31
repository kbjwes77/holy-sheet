// Admin stats: totals, per-day charts, the sign-up funnel, referrers, landing and top pages, and recent sign-ups
// with their journeys. The API is server/analytics.ts.
import { $, api, el, errorText, startPage } from "./common.ts";

const { me } = await startPage("admin");
if (!me.isAdmin) location.replace("/dashboard");

interface Day {
    date: string;
    signups: number;
    accounts: number;
    materials: number;
    gradeRuns: number;
    pages: number;
    visitors: number;
    pageviews: number;
}
interface Source {
    name: string | null;
    visitors: number;
    signups: number;
}
interface Stats {
    days: number;
    totals: { accounts: number; pro: number; materials: number; gradeRuns: number; pagesGraded: number; visitors: number };
    series: Day[];
    referrers: Source[];
    campaigns: { source: string; medium: string | null; campaign: string | null; visitors: number; signups: number }[];
    landings: Source[];
    pages: { name: string; views: number; visitors: number }[];
    funnel: { visitors: number; signups: number; material: number; graded: number; pro: number };
    signups: { id: number; email: string; displayName: string; plan: string; createdAt: number; referrer: string | null; landing: string | null; utmSource: string | null; utmCampaign: string | null; viewsBefore: number }[];
}
interface JourneyEvent {
    kind: string;
    path: string | null;
    referrer: string | null;
    quantity: number;
    at: number;
    visitor: string | null;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const compact = (n: number) => (n >= 10_000 ? new Intl.NumberFormat("en-US", { notation: "compact" }).format(n) : fmt(n));
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");
const dayLabel = (date: string, long = false) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(long ? { year: "numeric" } : {}), timeZone: "UTC" });
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// ---- Totals

function renderTotals(t: Stats["totals"]): void {
    const tiles: [string, string, number][] = [
        ["bi-people", "Accounts", t.accounts],
        ["bi-star", "Pro accounts", t.pro],
        ["bi-collection", "Study materials", t.materials],
        ["bi-clipboard-check", "Grading runs", t.gradeRuns],
        ["bi-file-earmark-check", "Pages graded", t.pagesGraded],
        ["bi-person-walking", "Visitors", t.visitors],
    ];
    $("totals").replaceChildren(
        ...tiles.map(([icon, label, value]) => {
            const tile = el("div", "card shadow-sm stat-tile");
            tile.innerHTML = `<span class="tile-icon"><i class="bi ${icon}"></i></span>`;
            const text = el("div");
            text.append(el("div", "small fg-secondary", label), el("div", "fs-xl fw-semibold stat-value", compact(value)));
            tile.append(text);
            return tile;
        }),
    );
}

// ---- Per-day charts: one series each, so no legend; the title names it. Hovering a day shows its value.

const SVG = "http://www.w3.org/2000/svg";
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
};

/** A clean axis maximum (1, 2 or 5 × a power of ten) at or above `max`. */
function niceMax(max: number): number {
    if (max <= 4) return 4;
    const p = 10 ** Math.floor(Math.log10(max));
    return ([1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= max) ?? 10 * p);
}

const tooltip = $("tooltip");
function showTip(target: Element, title: string, value: string): void {
    tooltip.replaceChildren(el("div", "small fg-secondary", title), el("div", "fw-semibold", value));
    tooltip.classList.remove("d-none");
    const r = target.getBoundingClientRect();
    const t = tooltip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - t.width - 8, Math.max(8, r.left + r.width / 2 - t.width / 2));
    tooltip.style.left = `${left + scrollX}px`;
    tooltip.style.top = `${r.top + scrollY - t.height - 8}px`;
}
const hideTip = () => tooltip.classList.add("d-none");

function chart(title: string, series: Day[], value: (d: Day) => number, unit: string, kind: "columns" | "line"): HTMLElement {
    const card = el("section", "card shadow-sm");
    const body = el("div", "card-body");
    const values = series.map(value);
    const total = values.reduce((a, b) => a + b, 0);
    const head = el("div", "d-flex align-items-baseline gap-3 mb-2");
    head.append(el("h3", "fs-md fw-semibold mb-0 me-auto", title));
    head.append(el("span", "small fg-secondary", kind === "line" ? `${fmt(values.at(-1) ?? 0)} now` : `${fmt(total)} in ${series.length} days`));
    body.append(head);

    const W = 600;
    const H = 160;
    const left = 36;
    const bottom = 20;
    const top = 8;
    const plotW = W - left - 4;
    const plotH = H - bottom - top;
    const max = niceMax(Math.max(...values, 0));
    const y = (v: number) => top + plotH - (v / max) * plotH;
    const slot = plotW / series.length;
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "stats-chart", role: "img", "aria-label": `${title}, per day` });

    // Recessive grid: the baseline, a midline and the top, labeled.
    for (const v of [0, max / 2, max]) {
        root.append(svg("line", { x1: left, x2: W - 4, y1: y(v), y2: y(v), class: v === 0 ? "axis" : "grid" }));
        const label = svg("text", { x: left - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" });
        label.textContent = compact(v);
        root.append(label);
    }
    // Date ticks: the first and last day, and the middle one when there's room.
    const ticks = series.length > 2 ? [0, Math.floor((series.length - 1) / 2), series.length - 1] : [0, series.length - 1];
    for (const i of new Set(ticks)) {
        const t = svg("text", { x: left + slot * i + slot / 2, y: H - 4, class: "tick", "text-anchor": i === 0 ? "start" : i === series.length - 1 ? "end" : "middle" });
        t.textContent = dayLabel(series[i]!.date);
        root.append(t);
    }

    if (kind === "columns") {
        // Thin columns (<= 24px) with a 2px gap, rounded at the data end, square at the baseline.
        const w = Math.max(1, Math.min(24, slot - 2));
        series.forEach((d, i) => {
            const v = value(d);
            if (!v) return;
            const h = Math.max(2, (v / max) * plotH);
            const x = left + slot * i + (slot - w) / 2;
            const r = Math.min(4, w / 2, h);
            const y0 = top + plotH;
            root.append(svg("path", { class: "mark", d: `M${x},${y0} V${y0 - h + r} Q${x},${y0 - h} ${x + r},${y0 - h} H${x + w - r} Q${x + w},${y0 - h} ${x + w},${y0 - h + r} V${y0} Z` }));
        });
    } else {
        const pts = series.map((d, i) => `${left + slot * i + slot / 2},${y(value(d))}`);
        root.append(svg("path", { class: "area", d: `M${left + slot / 2},${top + plotH} L${pts.join(" L")} L${left + slot * (series.length - 1) + slot / 2},${top + plotH} Z` }));
        root.append(svg("polyline", { class: "line", points: pts.join(" ") }));
        const last = series.length - 1;
        root.append(svg("circle", { class: "dot", cx: left + slot * last + slot / 2, cy: y(value(series[last]!)), r: 4 }));
    }

    // Hover: a full-height target per day, wider than the mark; a guide line marks the day.
    const guide = svg("line", { class: "guide", y1: top, y2: top + plotH, x1: 0, x2: 0, visibility: "hidden" });
    root.append(guide);
    series.forEach((d, i) => {
        const hit = svg("rect", { class: "hit", x: left + slot * i, y: top, width: slot, height: plotH });
        const cx = left + slot * i + slot / 2;
        const show = () => {
            guide.setAttribute("x1", String(cx));
            guide.setAttribute("x2", String(cx));
            guide.setAttribute("visibility", "visible");
            showTip(hit, dayLabel(d.date, true), `${fmt(value(d))} ${unit}`);
        };
        hit.addEventListener("pointerenter", show);
        hit.addEventListener("pointerleave", () => {
            guide.setAttribute("visibility", "hidden");
            hideTip();
        });
        root.append(hit);
    });
    body.append(root);
    card.append(body);
    return card;
}

function renderCharts(series: Day[]): void {
    $("charts").replaceChildren(
        chart("Accounts", series, (d) => d.accounts, "accounts", "line"),
        chart("Sign-ups", series, (d) => d.signups, "sign-ups", "columns"),
        chart("Study materials added", series, (d) => d.materials, "materials", "columns"),
        chart("Pages graded", series, (d) => d.pages, "pages", "columns"),
        chart("Grading runs", series, (d) => d.gradeRuns, "runs", "columns"),
        chart("Visitors", series, (d) => d.visitors, "visitors", "columns"),
    );
    const rows = [...series].reverse().map((d) => {
        const tr = el("tr");
        tr.append(el("td", "", dayLabel(d.date, true)));
        for (const v of [d.accounts, d.signups, d.materials, d.gradeRuns, d.pages, d.visitors, d.pageviews]) tr.append(el("td", "text-end", fmt(v)));
        return tr;
    });
    $("daily-table").querySelector("tbody")!.replaceChildren(...rows);
}

// ---- Funnel and tables

function renderFunnel(f: Stats["funnel"]): void {
    const steps: [string, number, number][] = [
        ["New visitors", f.visitors, f.visitors],
        ["Signed up", f.signups, f.visitors],
        ["Added a material", f.material, f.signups],
        ["Graded sheets", f.graded, f.signups],
        ["On Pro", f.pro, f.signups],
    ];
    const top = Math.max(f.visitors, f.signups, 1);
    $("funnel").replaceChildren(
        ...steps.map(([label, n, of], i) => {
            const row = el("div", "funnel-row");
            const text = el("div", "d-flex small mb-1");
            text.append(el("span", "me-auto", label), el("span", "fw-semibold", fmt(n)));
            if (i > 0) text.append(el("span", "fg-secondary ms-2 funnel-pct", pct(n, of)));
            const track = el("div", "funnel-track");
            const bar = el("div", "funnel-bar");
            bar.style.width = `${(n / top) * 100}%`;
            track.append(bar);
            row.append(text, track);
            return row;
        }),
        el("p", "small fg-secondary mt-3 mb-0", "Percentages after sign-up are of the accounts created in the range."),
    );
}

function table(id: string, head: string[], rows: (string | number)[][], empty: string): void {
    const t = $<HTMLTableElement>(id);
    const thead = el("thead");
    const hr = el("tr");
    head.forEach((h, i) => hr.append(Object.assign(el("th", i ? "text-end" : "", h), { scope: "col" })));
    thead.append(hr);
    const tbody = el("tbody");
    if (!rows.length) {
        const tr = el("tr");
        const td = el("td", "fg-secondary", empty);
        td.colSpan = head.length;
        tr.append(td);
        tbody.append(tr);
    }
    for (const r of rows) {
        const tr = el("tr");
        r.forEach((v, i) => tr.append(el("td", i ? "text-end" : "text-break", typeof v === "number" ? fmt(v) : v)));
        tbody.append(tr);
    }
    t.replaceChildren(thead, tbody);
}

function cameFrom(s: { referrer: string | null; utmSource: string | null; utmCampaign: string | null }): string {
    if (s.utmSource) return `${s.utmSource}${s.utmCampaign ? ` / ${s.utmCampaign}` : ""}`;
    return s.referrer ?? "(direct)";
}

// ---- Journeys

const JOURNEY_LABELS: Record<string, string> = { signup: "Signed up", material: "Added a material", grade: "Graded sheets" };

async function toggleJourney(row: HTMLTableRowElement, userId: number, button: HTMLButtonElement): Promise<void> {
    const open = row.nextElementSibling?.classList.contains("journey-row");
    if (open) {
        row.nextElementSibling!.remove();
        button.ariaExpanded = "false";
        return;
    }
    button.disabled = true;
    try {
        const { events } = await api<{ events: JourneyEvent[] }>(`/api/admin/journey/${userId}`);
        const tr = el("tr", "journey-row");
        const td = el("td");
        td.colSpan = 7;
        const list = el("ol", "journey small mb-0");
        if (!events.length) list.append(el("li", "fg-secondary", "No visits recorded (the account may predate tracking, or its browser opted out)."));
        // Number the browsers only when the account used more than one.
        const browsers = new Map([...new Set(events.map((e) => e.visitor).filter((v): v is string => !!v))].map((v, i) => [v, i + 1]));
        for (const e of events) {
            const li = el("li");
            li.append(el("span", "fg-secondary journey-time", when(e.at)));
            if (e.kind === "pageview") {
                li.append(el("code", "", e.path ?? ""));
                if (e.referrer) li.append(el("span", "fg-secondary", ` from ${e.referrer}`));
            } else li.append(el("strong", "", `${JOURNEY_LABELS[e.kind] ?? e.kind}${e.kind === "grade" ? ` (${fmt(e.quantity)} pages)` : ""}`));
            if (e.visitor && browsers.size > 1) li.append(el("span", "badge badge-subtle theme-secondary ms-2", `browser ${browsers.get(e.visitor)}`));
            list.append(li);
        }
        td.append(list);
        tr.append(td);
        row.after(tr);
        button.ariaExpanded = "true";
    } catch (err) {
        $("error").textContent = errorText(err);
        $("error").classList.remove("d-none");
    } finally {
        button.disabled = false;
    }
}

function renderSignups(signups: Stats["signups"]): void {
    const tbody = $("signups").querySelector("tbody")!;
    tbody.replaceChildren(
        ...signups.map((s) => {
            const tr = el("tr");
            tr.append(el("td", "text-nowrap", when(s.createdAt)));
            const who = el("td");
            who.append(el("div", "", s.displayName), el("div", "fg-secondary text-break", s.email));
            tr.append(who);
            tr.append(el("td", "", s.plan === "pro" ? "Pro" : "Free"));
            tr.append(el("td", "text-break", s.landing === null ? "–" : cameFrom(s)));
            tr.append(el("td", "text-break", s.landing ?? "–"));
            tr.append(el("td", "text-end", fmt(s.viewsBefore)));
            const td = el("td", "text-end");
            const button = el("button", "btn-sm btn-outline theme-secondary text-nowrap", "Journey");
            button.type = "button";
            button.ariaExpanded = "false";
            button.addEventListener("click", () => void toggleJourney(tr, s.id, button));
            td.append(button);
            tr.append(td);
            return tr;
        }),
    );
}

// ---- Loading

async function load(days: number): Promise<void> {
    $("error").classList.add("d-none");
    try {
        const s = await api<Stats>(`/api/admin/stats?days=${days}`);
        $("range-note").textContent = `${dayLabel(s.series[0]!.date, true)} – ${dayLabel(s.series.at(-1)!.date, true)}`;
        renderTotals(s.totals);
        renderCharts(s.series);
        renderFunnel(s.funnel);
        table("referrers", ["Site", "Visitors", "Signed up", "Rate"], s.referrers.map((r) => [r.name ?? "(direct)", r.visitors, r.signups, pct(r.signups, r.visitors)]), "No visitors in this range.");
        table("landings", ["Page", "Visitors", "Signed up", "Rate"], s.landings.map((r) => [r.name ?? "–", r.visitors, r.signups, pct(r.signups, r.visitors)]), "No visitors in this range.");
        table("pages", ["Page", "Views", "Visitors"], s.pages.map((p) => [p.name, p.views, p.visitors]), "No page views in this range.");
        $("campaigns-card").classList.toggle("d-none", !s.campaigns.length);
        table("campaigns", ["Source / medium / campaign", "Visitors", "Signed up", "Rate"], s.campaigns.map((c) => [[c.source, c.medium, c.campaign].filter(Boolean).join(" / "), c.visitors, c.signups, pct(c.signups, c.visitors)]), "");
        renderSignups(s.signups);
    } catch (err) {
        $("error").textContent = `Couldn't load the stats: ${errorText(err)}`;
        $("error").classList.remove("d-none");
    }
}

let range = 30;
try {
    range = Number(localStorage.getItem("statsRange")) || 30;
} catch {}
const radio = document.querySelector<HTMLInputElement>(`#range input[value="${range}"]`);
if (radio) radio.checked = true;
else range = 30;
$("range").addEventListener("change", (e) => {
    range = Number((e.target as HTMLInputElement).value);
    try {
        localStorage.setItem("statsRange", String(range));
    } catch {}
    void load(range);
});
void load(range);
