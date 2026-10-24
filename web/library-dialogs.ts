// Dialogs for the material library, shared by the library page, Print Sheets and the grader:
// pick a saved material, and create or edit one.
import { api, apiMultipart, el, errorText, JSON_MATERIAL_TYPES, MATERIAL_TYPE_THEMES, STATUSES, type Group, type Material } from "./common.ts";
import { openDialog } from "./dialog.ts";

const MAX_DECK_BYTES = 25 * 1024 * 1024;

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
    return openDialog<Material>({ title: "Open from library" }, (body, _footer, close) => {
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
                // Decks have no test JSON, so they aren't offered to Print Sheets/the grader. Ask the
                // server to skip them: filtering a page here could leave "Nothing here yet."
                for (const t of JSON_MATERIAL_TYPES) params.append("type", t);
                const { materials } = await api<{ materials: Material[] }>(`/api/materials?${params}`);
                list.replaceChildren(
                    ...materials.map((m) => {
                        const b = el("button", "list-group-item list-group-item-action d-flex align-items-center gap-3 text-start");
                        b.type = "button";
                        b.append(el("span", "fw-medium me-auto", m.name), el("span", `badge badge-subtle ${MATERIAL_TYPE_THEMES[m.type]}`, m.type), el("span", "small fg-secondary", m.mine ? m.status : `by ${m.author}`));
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
        return search;
    });
}

export interface EditOptions {
    /** The material being edited; omit to create one. */
    material?: Material;
    /** Test JSON for a new material (the Print Sheets editor); with `askContent` it pre-fills the box. */
    content?: string;
    /** Show a JSON box (the library page); Print Sheets already has its content. */
    askContent?: boolean;
    /** A name to pre-fill for a new material. */
    name?: string;
    /** The type a new material starts as (Print Sheets passes the sheet's root type). */
    type?: Material["type"];
    /** The group a new material starts in. */
    groupId?: number | null;
    /** A .pptx to create a Slides material from (drag-and-drop or file picker). */
    deckFile?: File;
}

function bytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Creates or edits a material; resolves with the saved material, or null if cancelled. */
export async function editMaterial(o: EditOptions): Promise<Material | null> {
    const { groups } = await api<{ groups: Group[] }>("/api/groups");
    const paths = groupPaths(groups);
    const m = o.material;
    const isDeck = m?.type === "Slides" || !!o.deckFile;
    // Editing fetches the content too, so the box shows what is saved. Decks have no JSON.
    const full = m && o.askContent && !isDeck ? await api<Material>(`/api/materials/${m.id}`) : m;
    const title = m ? `Edit "${m.name}"` : isDeck ? "Save slide deck" : "Save to library";
    return openDialog<Material>({ title, size: "lg" }, (body, footer, close) => {
        const form = el("form");
        form.id = "material-dialog-form";
        const name = el("input", "form-control");
        name.id = "m-name";
        name.maxLength = 200;
        name.required = true;
        name.value = m?.name ?? o.name ?? "";
        const type = select(
            "m-type",
            (isDeck ? [["Slides", "Slides"]] : JSON_MATERIAL_TYPES.map((t) => [t, t])) as [string, string][],
            m?.type ?? (isDeck ? "Slides" : (o.type ?? "Worksheet")),
        );
        type.disabled = isDeck;
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

        let deckFile: File | null = o.deckFile ?? null;
        let deckNote: HTMLElement | null = null;
        if (isDeck) {
            const picker = el("input", "form-control");
            picker.type = "file";
            picker.accept = ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation";
            deckNote = el("div", "form-text");
            const showNote = () => {
                deckNote!.textContent = deckFile
                    ? `${deckFile.name} · ${bytes(deckFile.size)}`
                    : m?.fileName
                      ? `Current file: ${m.fileName}${m.fileSize ? ` · ${bytes(m.fileSize)}` : ""}. Choose a file to replace it.`
                      : "Choose a .pptx file, up to 25 MB.";
            };
            showNote();
            picker.addEventListener("change", () => {
                deckFile = picker.files?.[0] ?? null;
                showNote();
            });
            const deckField = field("PowerPoint file (.pptx)", picker);
            deckField.append(deckNote);
            form.append(deckField);
        }

        let content: HTMLTextAreaElement | null = null;
        if (o.askContent && !isDeck) {
            content = el("textarea", "form-control font-monospace");
            content.id = "m-content";
            content.rows = 10;
            content.spellcheck = false;
            content.value = full?.content ?? o.content ?? "";
            content.placeholder = "Test JSON (see Print Sheets for the format)";
            form.append(field("Test JSON", content));
        }
        const error = el("div", "alert theme-danger d-none");
        const cancel = el("button", "btn-outline theme-secondary", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => close(null));
        const save = el("button", "btn-solid theme-primary", "Save");
        save.type = "submit";
        save.setAttribute("form", form.id);
        footer.append(cancel, save);
        form.append(error);
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            error.classList.add("d-none");
            const fail = (message: string) => {
                error.textContent = message;
                error.classList.remove("d-none");
                save.disabled = false;
            };
            const tagList = tags.value.split(",");
            const groupId = group.value ? Number(group.value) : null;

            if (isDeck) {
                if (!deckFile && !m) return fail("Choose a .pptx file to upload.");
                if (deckFile && !deckFile.name.toLowerCase().endsWith(".pptx")) return fail("Only .pptx files are accepted.");
                if (deckFile && deckFile.size > MAX_DECK_BYTES) return fail("The deck is larger than 25 MB.");
                save.disabled = true;
                try {
                    if (m && !deckFile) {
                        close(
                            await api<Material>(`/api/materials/${m.id}`, {
                                method: "PATCH",
                                body: { name: name.value, status: status.value, tags: tagList, groupId },
                            }),
                        );
                        return;
                    }
                    // One request: the server applies the file and metadata in a single transaction,
                    // so a failed upload can't leave (for example) a newly published deck behind.
                    const upload = new FormData();
                    upload.append("name", name.value);
                    upload.append("status", status.value);
                    upload.append("tags", JSON.stringify(tagList));
                    upload.append("groupId", groupId === null ? "" : String(groupId));
                    upload.append("file", deckFile!);
                    close(await apiMultipart<Material>(m ? `/api/materials/${m.id}` : "/api/materials", upload, m ? "PATCH" : "POST"));
                } catch (err) {
                    fail(errorText(err));
                }
                return;
            }

            save.disabled = true;
            const payload = {
                name: name.value,
                type: type.value,
                status: status.value,
                tags: tagList,
                groupId,
                ...(content ? { content: content.value } : m ? {} : { content: o.content ?? "" }),
            };
            try {
                close(await api<Material>(m ? `/api/materials/${m.id}` : "/api/materials", { method: m ? "PATCH" : "POST", body: payload }));
            } catch (err) {
                fail(errorText(err));
            }
        });
        body.append(form);
        return name;
    });
}

/**
 * The entry point for new materials: drop or choose a .pptx, or pick one of the JSON-based
 * material kinds. Once a kind is chosen this hands off to the normal save dialog.
 */
export async function createMaterial(o: { groupId?: number | null } = {}): Promise<Material | null> {
    let deckFile: File | null = null;
    const choice = await openDialog<"slides" | "StudyGuide" | "Quiz">({ title: "Create Study Material" }, (body, footer, close) => {
        const input = el("input");
        input.type = "file";
        input.accept = ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation";
        input.hidden = true;

        const zone = el("button", "create-upload");
        zone.type = "button";
        zone.innerHTML = `
            <i class="bi bi-easel create-upload-icon" aria-hidden="true"></i>
            <span class="create-upload-title">Upload Slides</span>
            <span class="create-upload-hint">or drag .pptx file here</span>
        `;

        const error = el("div", "alert theme-danger d-none");
        error.setAttribute("role", "alert");
        const fail = (message: string) => {
            error.textContent = message;
            error.classList.remove("d-none");
        };
        const accept = (file: File) => {
            if (!file.name.toLowerCase().endsWith(".pptx")) return fail("Only .pptx files are accepted.");
            if (file.size > MAX_DECK_BYTES) return fail("The deck is larger than 25 MB.");
            deckFile = file;
            close("slides");
        };

        zone.addEventListener("click", () => input.click());
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            input.value = "";
            if (file) accept(file);
        });

        // The whole dialog accepts a dropped deck, not just the small upload area.
        body.addEventListener("dragover", (e) => {
            if (!e.dataTransfer?.types.includes("Files")) return;
            e.preventDefault();
            zone.classList.add("is-dragging");
        });
        body.addEventListener("dragleave", (e) => {
            if (!body.contains(e.relatedTarget as Node | null)) zone.classList.remove("is-dragging");
        });
        body.addEventListener("drop", (e) => {
            zone.classList.remove("is-dragging");
            const file = e.dataTransfer?.files[0];
            if (!file) return;
            e.preventDefault();
            accept(file);
        });

        const option = (type: "StudyGuide" | "Quiz", icon: string, title: string, text: string, tint: "success" | "info"): HTMLButtonElement => {
            const b = el("button", `create-option tint-${tint}`);
            b.type = "button";
            b.innerHTML = `
                <i class="bi ${icon} create-option-icon" aria-hidden="true"></i>
                <span class="create-option-title">${title}</span>
                <span class="create-option-text">${text}</span>
            `;
            b.addEventListener("click", () => close(type));
            return b;
        };
        const options = el("div", "create-options");
        options.append(
            option("StudyGuide", "bi-journal-text", "Create Study Guide", "Questions, answers and explanations to study from.", "success"),
            option("Quiz", "bi-ui-checks", "Create Quiz or Exam", "A test with multiple-choice or free-response questions.", "info"),
        );

        const cancel = el("button", "btn-outline theme-secondary", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => close(null));
        footer.append(cancel);

        body.append(zone, input, error, el("div", "create-divider", "or"), options);
        return zone;
    });

    if (!choice) return null;
    if (choice === "slides") {
        const name = deckFile!.name.replace(/\.pptx$/i, "").trim().slice(0, 200) || "Slide deck";
        return editMaterial({ deckFile: deckFile!, name, groupId: o.groupId });
    }
    return editMaterial({ askContent: true, type: choice, groupId: o.groupId });
}

/** A one-line text prompt (group names); resolves with the text, or null if cancelled. */
export function promptText(title: string, label: string, value = ""): Promise<string | null> {
    return openDialog<string>({ title }, (body, footer, close) => {
        const form = el("form");
        form.id = "prompt-text-form";
        const input = el("input", "form-control");
        input.id = "p-text";
        input.maxLength = 200;
        input.required = true;
        input.value = value;
        const cancel = el("button", "btn-outline theme-secondary", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => close(null));
        const ok = el("button", "btn-solid theme-primary", "OK");
        ok.type = "submit";
        ok.setAttribute("form", form.id);
        footer.append(cancel, ok);
        form.append(field(label, input));
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            if (input.value.trim()) close(input.value.trim());
        });
        body.append(form);
        return input;
    });
}
