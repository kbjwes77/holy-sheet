// Material rows and actions, shared by the library and community pages.
import { api, download, el, MATERIAL_TYPE_THEMES, type Material } from "./common.ts";
import { attachDeckThumbnail } from "./deck-thumbnail.ts";

export function typeFilter(select: HTMLSelectElement, types: readonly string[]): void {
    select.append(new Option("All types", ""));
    for (const t of types) select.append(new Option(t, t));
}

const TYPE_ICONS: Record<string, string> = {
    StudyGuide: "bi-journal-text",
    Worksheet: "bi-file-earmark-text",
    Quiz: "bi-ui-checks",
    Exam: "bi-clipboard-check",
};

export function materialRow(m: Material, actions: HTMLElement[] = [], grouped = true): HTMLElement {
    const row = el("div", "list-group-item material-row");
    const media = el("div", m.type === "Slides" ? "" : "material-icon");
    if (m.type === "Slides") {
        attachDeckThumbnail(media, m);
    } else {
        media.setAttribute("aria-hidden", "true");
        media.innerHTML = `<i class="bi ${TYPE_ICONS[m.type] ?? "bi-file-earmark-text"}"></i>`;
    }

    const main = el("div", "material-main");
    const content = el("div", "material-content");
    const top = el("div", "material-top");
    const meta = m.mine
        ? `Updated ${new Date(m.updatedAt * 1000).toLocaleDateString()}`
        : `by ${m.author} · Updated ${new Date(m.updatedAt * 1000).toLocaleDateString()}`;
    top.append(el("div", "fw-medium material-name", m.name), el("div", "small fg-secondary material-meta", meta));

    const bottom = el("div", "material-bottom");
    const badges = el("div", "d-flex align-items-center gap-1 flex-wrap");
    badges.append(el("span", `badge badge-subtle ${MATERIAL_TYPE_THEMES[m.type]}`, m.type));
    if (m.mine) badges.append(el("span", `badge badge-subtle ${m.status === "published" ? "theme-success" : m.status === "draft" ? "theme-warning" : "theme-secondary"}`, m.status));
    bottom.append(badges);
    if (actions.length) {
        const buttons = el("div", `${grouped ? "btn-group btn-group-sm" : "d-flex align-items-center"} material-actions`);
        buttons.append(...actions);
        bottom.append(buttons);
    }
    content.append(top, bottom);
    main.append(media, content);
    row.append(main);

    if (m.tags.length) {
        const details = el("details", "material-details");
        const summary = el("summary", "material-details-toggle small fg-secondary");
        summary.append("Details");
        const caret = document.createElement("i");
        caret.className = "bi bi-caret-right-fill material-details-caret";
        summary.append(caret);
        const tags = el("div", "mt-2 d-flex flex-wrap gap-1");
        for (const t of m.tags) tags.append(el("span", "badge badge-subtle theme-secondary", t));
        details.append(summary, tags);
        row.append(details);
    }
    return row;
}

export function button(icon: string, label: string, onClick: () => void | Promise<void>, theme = "theme-secondary", withText = false): HTMLButtonElement {
    const b = el("button", `btn-outline ${theme}`);
    b.type = "button";
    b.title = label;
    const glyph = document.createElement("i");
    glyph.className = `bi ${icon}${withText ? " me-1" : ""}`;
    b.append(glyph);
    if (withText) b.append(label);
    b.setAttribute("aria-label", label);
    b.addEventListener("click", () => void onClick());
    return b;
}

/** Downloads a material's original file through the API (which counts the download). */
export async function downloadMaterial(m: Material): Promise<void> {
    const res = await fetch(`/api/materials/${m.id}/download`);
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "download failed");
    const ext = m.type === "Slides" ? ".pptx" : ".json";
    download(`${m.name.replace(/[^\w.\- ]+/g, "_").trim() || "material"}${ext}`, await res.blob());
}

export function copyToLibrary(m: Material): Promise<Material> {
    return api<Material>(`/api/materials/${m.id}/copy`, { method: "POST" });
}
