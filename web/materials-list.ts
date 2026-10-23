// Material rows and actions, shared by the library and community pages.
import { api, download, el, type Material } from "./common.ts";

export function typeFilter(select: HTMLSelectElement, types: readonly string[]): void {
    select.append(new Option("All types", ""));
    for (const t of types) select.append(new Option(t, t));
}

export function materialRow(m: Material, actions: HTMLElement[] = []): HTMLElement {
    const row = el("div", "list-group-item d-flex align-items-center gap-3 flex-wrap");
    const text = el("div", "me-auto");
    text.append(el("div", "fw-medium", m.name));
    text.append(el("div", "small fg-secondary", `${m.mine ? "" : `by ${m.author} · `}updated ${new Date(m.updatedAt * 1000).toLocaleDateString()}`));
    if (m.tags.length) {
        const tags = el("div", "mt-1 d-flex flex-wrap gap-1");
        for (const t of m.tags) tags.append(el("span", "badge badge-subtle theme-secondary", t));
        text.append(tags);
    }
    row.append(text, el("span", "badge badge-subtle theme-secondary", m.type));
    if (m.mine) row.append(el("span", `badge badge-subtle ${m.status === "published" ? "theme-success" : m.status === "draft" ? "theme-warning" : "theme-secondary"}`, m.status));
    const buttons = el("div", "btn-group btn-group-sm");
    buttons.append(...actions);
    row.append(buttons);
    return row;
}

export function button(icon: string, label: string, onClick: () => void | Promise<void>, theme = "theme-secondary"): HTMLButtonElement {
    const b = el("button", `btn-outline ${theme}`);
    b.type = "button";
    b.title = label;
    b.innerHTML = `<i class="bi ${icon}"></i>`;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", () => void onClick());
    return b;
}

/** Downloads a material's JSON through the API (which counts the download). */
export async function downloadMaterial(m: Material): Promise<void> {
    const res = await fetch(`/api/materials/${m.id}/download`);
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "download failed");
    download(`${m.name.replace(/[^\w.\- ]+/g, "_").trim() || "material"}.json`, await res.blob());
}

export function copyToLibrary(m: Material): Promise<Material> {
    return api<Material>(`/api/materials/${m.id}/copy`, { method: "POST" });
}
