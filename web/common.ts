// Shared by the signed-in pages: API calls, the session check and the navigation bar.

export interface Me {
    id: number;
    email: string;
    displayName: string;
    plan: "free" | "pro";
    isAdmin: boolean;
    canGrade: boolean;
    usage: { gradeRunsThisMonth: number };
}

export const MATERIAL_TYPES = ["StudyGuide", "Worksheet", "Quiz", "Exam"] as const;
export const STATUSES = ["draft", "private", "published"] as const;

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

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
}

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Checks the session, builds the navigation bar into #nav and reveals the page. */
export async function startPage(active: string): Promise<{ me: Me; motd: string }> {
    const { user, motd } = await api<{ user: Me; motd: string }>("/api/me");
    const nav = $("nav");
    nav.className = "navbar border-bottom bg-2";
    const wrap = el("div", "container d-flex align-items-center gap-3 flex-wrap");
    const brand = el("a", "navbar-brand fw-semibold me-auto");
    brand.href = "/";
    brand.innerHTML = '<i class="bi bi-water me-3 fg-primary"></i>GradeLake';
    wrap.append(brand);
    const links: [string, string, string, string][] = [
        ["dashboard", "/", "bi-house", "Dashboard"],
        ["library", "/library", "bi-collection", "My Library"],
        ["browse", "/browse", "bi-globe2", "Browse"],
        ["generator", "/generator", "bi-ui-radios-grid", "Generator"],
        ["grader", "/grader", "bi-clipboard-check", "Grader"],
    ];
    for (const [id, href, icon, label] of links) {
        const a = el("a", `btn-sm ${id === active ? "btn-solid theme-primary" : "btn-outline theme-secondary"}`);
        a.href = href;
        a.innerHTML = `<i class="bi ${icon} me-1"></i>`;
        a.append(label);
        wrap.append(a);
    }
    wrap.append(el("span", "small fg-secondary ms-3", user.displayName));
    const out = el("button", "btn-sm btn-outline theme-secondary");
    out.type = "button";
    out.innerHTML = '<i class="bi bi-box-arrow-right me-1"></i>Sign out';
    out.addEventListener("click", async () => {
        await api("/api/auth/logout", { method: "POST" }).catch(() => {});
        location.assign("/login");
    });
    wrap.append(out);
    nav.replaceChildren(wrap);
    document.body.hidden = false;
    return { me: user, motd };
}

/** Where to go after signing in: the `next` page if it is on this site. */
export function nextPage(): string {
    const next = new URLSearchParams(location.search).get("next") ?? "";
    return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function download(name: string, blob: Blob): void {
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
