// Dialogs for the material library, shared by the library page, the generator and the grader:
// pick a saved material, and create or edit one.
import { api, el, errorText, MATERIAL_TYPES, STATUSES, type Group, type Material } from "./common.ts";

/** Opens a modal <dialog> around `body`; resolves with whatever `close(value)` was given (null when dismissed). */
function modal<T>(title: string, build: (body: HTMLElement, close: (value: T | null) => void) => void): Promise<T | null> {
    return new Promise((resolve) => {
        const dialog = el("dialog", "card shadow p-0");
        dialog.style.cssText = "width: min(40rem, 94vw); max-height: 90vh; overflow: auto; border: 1px solid var(--bs-border-color, #8884);";
        const header = el("div", "card-header d-flex align-items-center");
        header.append(el("span", "fw-semibold me-auto", title));
        const x = el("button", "btn-sm btn-outline theme-secondary");
        x.type = "button";
        x.innerHTML = '<i class="bi bi-x-lg"></i>';
        x.setAttribute("aria-label", "Close");
        const body = el("div", "card-body");
        dialog.append(header, body);
        header.append(x);
        let result: T | null = null;
        const close = (v: T | null) => {
            result = v;
            dialog.close();
        };
        x.addEventListener("click", () => close(null));
        dialog.addEventListener("close", () => {
            dialog.remove();
            resolve(result);
        });
        build(body, close);
        document.body.append(dialog);
        dialog.showModal();
    });
}

function field(label: string, control: HTMLElement, hint = ""): HTMLElement {
    const wrap = el("div", "mb-4");
    const l = el("label", "form-label", label);
    if (control.id) l.htmlFor = control.id;
    wrap.append(l, control);
    if (hint) wrap.append(el("div", "form-text", hint));
    return wrap;
}

function select(id: string, options: [string, string][], value: string): HTMLSelectElement {
    const s = el("select", "form-select");
    s.id = id;
    for (const [v, text] of options) s.append(new Option(text, v, false, v === value));
    return s;
}

/** A group's path as shown in menus, e.g. "Unit 4 / Quizzes". */
export function groupPaths(groups: Group[]): Map<number, string> {
    const byId = new Map(groups.map((g) => [g.id, g]));
    const path = (g: Group): string => (g.parentId !== null && byId.has(g.parentId) ? `${path(byId.get(g.parentId)!)} / ${g.name}` : g.name);
    return new Map(groups.map((g) => [g.id, path(g)]));
}

/** Opens a dialog to choose one of the user's saved materials (or a community one); resolves with it, content included. */
export function pickMaterial(): Promise<Material | null> {
    return modal<Material>("Open from library", (body, close) => {
        let scope: "mine" | "community" = "mine";
        const tabs = el("div", "btn-group btn-group-sm mb-4");
        const search = el("input", "form-control mb-4");
        search.type = "search";
        search.placeholder = "Search by name";
        const list = el("div", "list-group");
        const status = el("div", "small fg-secondary mt-3");
        const tabButton = (label: string, which: typeof scope) => {
            const b = el("button", "btn-outline theme-secondary", label);
            b.type = "button";
            b.addEventListener("click", () => {
                scope = which;
                load();
            });
            return b;
        };
        tabs.append(tabButton("My materials", "mine"), tabButton("Community", "community"));
        let timer: ReturnType<typeof setTimeout> | undefined;
        search.addEventListener("input", () => {
            clearTimeout(timer);
            timer = setTimeout(load, 250);
        });
        async function load(): Promise<void> {
            try {
                const params = new URLSearchParams({ scope, limit: "50" });
                if (search.value.trim()) params.set("q", search.value.trim());
                const { materials } = await api<{ materials: Material[] }>(`/api/materials?${params}`);
                list.replaceChildren(
                    ...materials.map((m) => {
                        const b = el("button", "list-group-item list-group-item-action d-flex align-items-center gap-3 text-start");
                        b.type = "button";
                        b.append(el("span", "fw-medium me-auto", m.name), el("span", "badge badge-subtle theme-secondary", m.type), el("span", "small fg-secondary", m.mine ? m.status : `by ${m.author}`));
                        b.addEventListener("click", async () => {
                            try {
                                close(await api<Material>(`/api/materials/${m.id}`));
                            } catch (e) {
                                status.textContent = errorText(e);
                            }
                        });
                        return b;
                    }),
                );
                status.textContent = materials.length ? "" : "Nothing here yet.";
            } catch (e) {
                status.textContent = errorText(e);
            }
        }
        body.append(tabs, search, list, status);
        void load();
    });
}

export interface EditOptions {
    /** The material being edited; omit to create one. */
    material?: Material;
    /** Test JSON for a new material (the generator's editor); with `askContent` it pre-fills the box. */
    content?: string;
    /** Show a JSON box (the library page); the generator already has its content. */
    askContent?: boolean;
    /** A name to pre-fill for a new material. */
    name?: string;
    /** The group a new material starts in. */
    groupId?: number | null;
}

/** Creates or edits a material; resolves with the saved material, or null if cancelled. */
export async function editMaterial(o: EditOptions): Promise<Material | null> {
    const { groups } = await api<{ groups: Group[] }>("/api/groups");
    const paths = groupPaths(groups);
    const m = o.material;
    // Editing fetches the content too, so the box shows what is saved.
    const full = m && o.askContent ? await api<Material>(`/api/materials/${m.id}`) : m;
    return modal<Material>(m ? `Edit "${m.name}"` : "Save to library", (body, close) => {
        const form = el("form");
        const name = el("input", "form-control");
        name.id = "m-name";
        name.maxLength = 200;
        name.required = true;
        name.value = m?.name ?? o.name ?? "";
        const type = select("m-type", MATERIAL_TYPES.map((t) => [t, t]), m?.type ?? "Worksheet");
        const tags = el("input", "form-control");
        tags.id = "m-tags";
        tags.value = (m?.tags ?? []).join(", ");
        tags.placeholder = "e.g. macroeconomics, unit 4";
        const status = select("m-status", STATUSES.map((s) => [s, s[0]!.toUpperCase() + s.slice(1)]), m?.status ?? "draft");
        const group = select("m-group", [["", "(no group)"], ...[...paths].sort((a, b) => a[1].localeCompare(b[1])).map(([id, p]): [string, string] => [String(id), p])], String(m ? (m.groupId ?? "") : (o.groupId ?? "")));
        const row = el("div", "row g-4");
        const col = (c: HTMLElement) => {
            const d = el("div", "col-6");
            d.append(c);
            return d;
        };
        row.append(col(field("Type", type)), col(field("Status", status, "Published shows it to every signed-in user.")));
        form.append(field("Name", name), row, field("Tags", tags, "Comma-separated, up to 10."), field("Group", group));
        let content: HTMLTextAreaElement | null = null;
        if (o.askContent) {
            content = el("textarea", "form-control font-monospace");
            content.id = "m-content";
            content.rows = 10;
            content.spellcheck = false;
            content.value = full?.content ?? o.content ?? "";
            content.placeholder = "Test JSON (see the Sheet Generator for the format)";
            form.append(field("Test JSON", content));
        }
        const error = el("div", "alert theme-danger d-none");
        const buttons = el("div", "d-flex justify-content-end gap-3");
        const cancel = el("button", "btn-outline theme-secondary", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => close(null));
        const save = el("button", "btn-solid theme-primary", "Save");
        save.type = "submit";
        buttons.append(cancel, save);
        form.append(error, buttons);
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            error.classList.add("d-none");
            save.disabled = true;
            const payload = {
                name: name.value,
                type: type.value,
                status: status.value,
                tags: tags.value.split(","),
                groupId: group.value ? Number(group.value) : null,
                ...(content ? { content: content.value } : m ? {} : { content: o.content ?? "" }),
            };
            try {
                close(await api<Material>(m ? `/api/materials/${m.id}` : "/api/materials", { method: m ? "PATCH" : "POST", body: payload }));
            } catch (err) {
                error.textContent = errorText(err);
                error.classList.remove("d-none");
                save.disabled = false;
            }
        });
        body.append(form);
        name.focus();
    });
}

/** A one-line text prompt (group names); resolves with the text, or null if cancelled. */
export function promptText(title: string, label: string, value = ""): Promise<string | null> {
    return modal<string>(title, (body, close) => {
        const form = el("form");
        const input = el("input", "form-control");
        input.id = "p-text";
        input.maxLength = 200;
        input.required = true;
        input.value = value;
        const buttons = el("div", "d-flex justify-content-end gap-3");
        const cancel = el("button", "btn-outline theme-secondary", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => close(null));
        const ok = el("button", "btn-solid theme-primary", "OK");
        ok.type = "submit";
        buttons.append(cancel, ok);
        form.append(field(label, input), buttons);
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            if (input.value.trim()) close(input.value.trim());
        });
        body.append(form);
        input.focus();
    });
}
