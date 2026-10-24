// Shared by the signed-in pages: API calls, the session check and the app shell (sidebar and theme switch).
import "bootstrap/js/dist/drawer.js";

export interface Me {
    id: number;
    email: string;
    displayName: string;
    plan: "free" | "pro";
    isAdmin: boolean;
    canGrade: boolean;
    billing: { trialAvailable: boolean; manageable: boolean; status: string | null; interval: "month" | "year" | null; periodEnd: number | null; cancelAtPeriodEnd: boolean };
    usage: { gradeRunsThisMonth: number };
}

export const MATERIAL_TYPES = ["StudyGuide", "Worksheet", "Quiz", "Exam", "Slides"] as const;
export const STATUSES = ["draft", "private", "published"] as const;
/** Materials whose content is test JSON rather than an uploaded .pptx. */
export const JSON_MATERIAL_TYPES = MATERIAL_TYPES.filter((t) => t !== "Slides");

/** The theme used for each material type's badge and icon. */
export const MATERIAL_TYPE_THEMES: Record<(typeof MATERIAL_TYPES)[number], string> = {
    Slides: "theme-accent",
    StudyGuide: "theme-success",
    Worksheet: "theme-secondary",
    Quiz: "theme-info",
    Exam: "theme-info",
};

export interface Material {
    id: number;
    type: (typeof MATERIAL_TYPES)[number];
    name: string;
    tags: string[];
    status: (typeof STATUSES)[number];
    groupId: number | null;
    author: string;
    mine: boolean;
    createdAt: number;
    updatedAt: number;
    content?: string;
    /** Slides only: the uploaded file's original name and size. */
    fileName?: string | null;
    fileSize?: number;
}

export interface Group {
    id: number;
    parentId: number | null;
    name: string;
    description: string;
    status: (typeof STATUSES)[number];
}

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

/** Sends the user to the sign-in page, remembering where they were. */
function toLogin(): never {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw new ApiError(401, "not signed in");
}

/** A JSON API call. A 401 sends the user to sign in; other failures throw an ApiError with the server's message. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(path, {
        method: init.method ?? "GET",
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } }),
    });
    if (res.status === 401 && !path.startsWith("/api/auth/")) toLogin();
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `request failed (${res.status})`);
    return data as T;
}

/** A multipart API call (file uploads). Behaves like `api`, but sends `FormData` untouched. */
export async function apiMultipart<T = unknown>(path: string, form: FormData, method = "POST"): Promise<T> {
    const res = await fetch(path, { method, body: form });
    if (res.status === 401) toLogin();
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? `request failed (${res.status})`);
    return data as T;
}

/** Fetches a material's original bytes (a .pptx for Slides). */
export async function materialFile(id: number): Promise<ArrayBuffer> {
    const res = await fetch(`/api/materials/${id}/file`);
    if (res.status === 401) toLogin();
    if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(res.status, data.error ?? "couldn't load the file");
    }
    return res.arrayBuffer();
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
}

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type ThemePref = "light" | "dark";

/** The saved theme choice, or null (follow the OS) until the user flips the switch. */
export function themePref(): ThemePref | null {
    try {
        const v = localStorage.getItem("theme");
        if (v === "light" || v === "dark") return v;
    } catch {}
    return null;
}

function applyTheme(pref: ThemePref | null): void {
    document.documentElement.dataset.bsTheme = pref ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(themePref()));

/** The dark mode switch at the bottom of the sidebar. */
function themeSwitch(): HTMLElement {
    const row = el("div", "d-flex align-items-center gap-3 px-3");
    const wrap = el("span", "switch");
    const input = el("input");
    input.type = "checkbox";
    input.id = "theme-switch";
    input.role = "switch";
    input.checked = document.documentElement.dataset.bsTheme === "dark";
    input.addEventListener("change", () => {
        const pref: ThemePref = input.checked ? "dark" : "light";
        try {
            localStorage.setItem("theme", pref);
        } catch {}
        applyTheme(pref);
    });
    wrap.append(input);
    const label = el("label", "small fg-secondary", "Dark mode");
    label.htmlFor = input.id;
    row.append(wrap, label);
    return row;
}

/**
 * Checks the session, builds the app shell (a sidebar on desktop, a drawer opened from a top bar on
 * mobile) around the page's <main>, and reveals the page.
 */
export async function startPage(active: string): Promise<{ me: Me; motd: string }> {
    const { user, motd } = await api<{ user: Me; motd: string }>("/api/me");
    const brandHtml = '<img src="/images/logo-square.svg" alt="" width="28" height="27" />Grade Lake';

    const links: [string, string, string, string][] = [
        ["dashboard", "/dashboard", "bi-house", "Dashboard"],
        ["library", "/library", "bi-collection", "My Library"],
        ["browse", "/browse", "bi-globe2", "Browse"],
        ["generator", "/generator", "bi-ui-radios-grid", "Generator"],
        ["grader", "/grader", "bi-clipboard-check", "Grade"],
        ["pricing", "/pricing", "bi-credit-card", user.plan === "pro" ? "Billing" : "Upgrade"],
    ];
    const nav = el("nav", "sidebar-nav");
    nav.ariaLabel = "Main";
    for (const [id, href, icon, label] of links) {
        const a = el("a", `sidebar-link${id === active ? " active" : ""}`);
        a.href = href;
        if (id === active) a.ariaCurrent = "page";
        a.innerHTML = `<i class="bi ${icon}"></i>`;
        a.append(label);
        nav.append(a);
    }

    const out = el("button", "btn-sm btn-outline theme-secondary");
    out.type = "button";
    out.innerHTML = '<i class="bi bi-box-arrow-right me-1"></i>Sign out';
    out.addEventListener("click", async () => {
        await api("/api/auth/logout", { method: "POST" }).catch(() => {});
        location.assign("/login");
    });
    const who = el("div", "small fg-secondary text-truncate px-3");
    who.innerHTML = '<i class="bi bi-person me-2"></i>';
    who.append(user.displayName);
    const footer = el("div", "sidebar-footer");
    footer.append(who, themeSwitch(), out);

    // Below md this is the drawer (header with a close button); from md up Bootstrap lays it out as a plain column.
    const drawer = el("dialog", "md:drawer drawer-start app-sidebar-drawer");
    drawer.id = "app-drawer";
    drawer.ariaLabel = "Menu";
    const header = el("div", "drawer-header");
    const drawerBrand = el("a", "sidebar-brand p-0");
    drawerBrand.href = "/";
    drawerBrand.innerHTML = brandHtml;
    const close = el("button", "btn-close");
    close.type = "button";
    close.ariaLabel = "Close";
    close.dataset.bsDismiss = "drawer";
    header.append(drawerBrand, close);
    const deskBrand = el("a", "sidebar-brand sidebar-brand-desk");
    deskBrand.href = "/";
    deskBrand.innerHTML = brandHtml;
    const body = el("div", "drawer-body");
    body.append(deskBrand, nav, footer);
    drawer.append(header, body);
    const aside = el("aside", "app-sidebar");
    aside.append(drawer);

    const burger = el("button", "btn-outline theme-secondary btn-sm");
    burger.type = "button";
    burger.ariaLabel = "Open menu";
    burger.dataset.bsToggle = "drawer";
    burger.dataset.bsTarget = "#app-drawer";
    burger.innerHTML = '<i class="bi bi-list"></i>';
    const topbarBrand = el("a", "sidebar-brand p-0");
    topbarBrand.href = "/";
    topbarBrand.innerHTML = brandHtml;
    const topbar = el("header", "app-topbar");
    topbar.append(burger, topbarBrand);

    const main = document.querySelector("main")!;
    const content = el("div", "app-content");
    const shell = el("div", "app-shell");
    shell.append(aside, content);
    $("nav").replaceWith(shell);
    content.append(topbar, main);
    document.body.hidden = false;
    return { me: user, motd };
}

/** Where to go after signing in: the `next` page if it is on this site. */
export function nextPage(): string {
    const next = new URLSearchParams(location.search).get("next") ?? "";
    return next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
}

export function download(name: string, blob: Blob): void {
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
