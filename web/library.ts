import "bootstrap/js/dist/menu.js";
import { $, api, el, errorText, MATERIAL_TYPES, startPage, STATUSES, type Group, type Material } from "./common.ts";
import { previewDeck } from "./deck-modal.ts";
import { createMaterial, editMaterial, promptText } from "./library-dialogs.ts";
import { button, downloadMaterial, materialRow, typeFilter } from "./materials-list.ts";

const MAX_DECK_BYTES = 25 * 1024 * 1024;

await startPage("library");

const error = $("error");
const q = $<HTMLInputElement>("filter-q");
const type = $<HTMLSelectElement>("filter-type");
const tag = $<HTMLInputElement>("filter-tag");
const groupStatus = $<HTMLSelectElement>("group-status");
typeFilter(type, MATERIAL_TYPES);
for (const s of STATUSES) groupStatus.append(new Option(s[0]!.toUpperCase() + s.slice(1), s));

let groups: Group[] = [];
/** The group being viewed; null is the top level (materials in no group). */
let selected: number | null = null;

function fail(e: unknown): void {
    error.textContent = errorText(e);
    error.classList.remove("d-none");
}

/** Runs an action, showing its failure on the page. */
async function attempt(fn: () => Promise<unknown>): Promise<void> {
    error.classList.add("d-none");
    try {
        await fn();
    } catch (e) {
        fail(e);
    }
}

function renderTree(): void {
    const children = (parent: number | null) => groups.filter((g) => g.parentId === parent);
    const items: HTMLElement[] = [];
    const add = (label: string, id: number | null, depth: number, icon: string) => {
        const b = el("button", `list-group-item list-group-item-action${id === selected ? " active" : ""}`);
        b.type = "button";
        b.style.paddingLeft = `${1 + depth * 1.25}rem`;
        b.innerHTML = `<i class="bi ${icon} me-2"></i>`;
        b.append(label);
        b.addEventListener("click", () => {
            selected = id;
            renderTree();
            void loadMaterials();
        });
        items.push(b);
        for (const c of children(id)) add(c.name, c.id, depth + 1, "bi-folder2");
    };
    add("Top level", null, 0, "bi-collection");
    $("group-tree").replaceChildren(...items);
    const g = groups.find((x) => x.id === selected);
    $("group-title").textContent = g ? g.name : "Top level";
    $("group-actions").classList.toggle("d-none", !g);
    if (g) groupStatus.value = g.status;
}

async function loadGroups(): Promise<void> {
    groups = (await api<{ groups: Group[] }>("/api/groups")).groups;
    if (selected !== null && !groups.some((g) => g.id === selected)) selected = null;
    renderTree();
}

async function loadMaterials(): Promise<void> {
    await attempt(async () => {
        const params = new URLSearchParams({ scope: "mine", limit: "200", group: selected === null ? "root" : String(selected) });
        if (q.value.trim()) params.set("q", q.value.trim());
        if (type.value) params.set("type", type.value);
        for (const t of tag.value.split(",")) if (t.trim()) params.append("tag", t.trim());
        const { total, materials } = await api<{ total: number; materials: Material[] }>(`/api/materials?${params}`);
        const menuItem = (icon: string, label: string, onClick: () => void | Promise<void>, theme = ""): HTMLButtonElement => {
            const item = el("button", `menu-item${theme ? ` ${theme}` : ""}`);
            item.type = "button";
            item.innerHTML = `<i class="bi ${icon} me-2"></i>`;
            item.append(label);
            item.addEventListener("click", () => void onClick());
            return item;
        };
        /** A deck's two visible actions plus its three-dot menu; the order follows the deck's status. */
        const deckControls = (m: Material): HTMLElement => {
            const edit = () => attempt(async () => (await editMaterial({ material: m, askContent: false })) && (await refresh()));
            const del = () =>
                attempt(async () => {
                    if (!confirm(`Delete "${m.name}"?`)) return;
                    await api(`/api/materials/${m.id}`, { method: "DELETE" });
                    await refresh();
                });
            const preview = () => attempt(() => previewDeck(m));
            const present = () => location.assign(`/slides?id=${m.id}`);
            const download = () => attempt(() => downloadMaterial(m));

            const action = (icon: string, label: string, onClick: () => void | Promise<void>) =>
                button(icon, label, onClick, "theme-secondary", true);

            const more = el("button", "btn-outline theme-secondary");
            more.type = "button";
            more.title = "More actions";
            more.setAttribute("aria-label", "More actions");
            more.setAttribute("aria-haspopup", "true");
            more.setAttribute("aria-expanded", "false");
            more.dataset.bsToggle = "menu";
            more.dataset.bsPlacement = "bottom-end";
            more.innerHTML = '<i class="bi bi-three-dots-vertical"></i>';

            const menu = el("div", "menu");
            const controls = el("div", "btn-group btn-group-sm");
            if (m.status === "draft") {
                controls.append(action("bi-pencil", "Edit", edit), action("bi-eye", "Preview", preview), more, menu);
                menu.append(
                    menuItem("bi-easel", "Present", present),
                    menuItem("bi-download", "Download", download),
                    menuItem("bi-trash", "Delete", del, "theme-danger"),
                );
            } else {
                controls.append(action("bi-eye", "Preview", preview), action("bi-easel", "Present", present), more, menu);
                menu.append(
                    menuItem("bi-pencil", "Edit", edit),
                    menuItem("bi-download", "Download", download),
                    menuItem("bi-trash", "Delete", del, "theme-danger"),
                );
            }
            return controls;
        };
        const actions = (m: Material): HTMLElement[] => {
            if (m.type === "Slides") return [deckControls(m)];
            const del = button(
                "bi-trash",
                "Delete",
                () =>
                    attempt(async () => {
                        if (!confirm(`Delete "${m.name}"?`)) return;
                        await api(`/api/materials/${m.id}`, { method: "DELETE" });
                        await refresh();
                    }),
                "theme-danger",
            );
            const edit = button("bi-pencil", "Edit", () => attempt(async () => (await editMaterial({ material: m, askContent: true })) && (await refresh())));
            return [
                edit,
                button("bi-download", "Download JSON", () => attempt(() => downloadMaterial(m))),
                button("bi-ui-radios-grid", "Open in Print Sheets", () => location.assign(`/generator?material=${m.id}`)),
                del,
            ];
        };
        $("materials").replaceChildren(...materials.map((m) => materialRow(m, actions(m), m.type !== "Slides")));
        $("count").textContent = total ? `${total} material${total === 1 ? "" : "s"}` : "Nothing here yet. Use Create Study Material to add one.";
    });
}

const refresh = async () => {
    await loadGroups();
    await loadMaterials();
};

$("btn-new-material").addEventListener("click", () =>
    attempt(async () => (await createMaterial({ groupId: selected })) && (await refresh())),
);
$("btn-new-group").addEventListener("click", () =>
    attempt(async () => {
        const name = await promptText("New group", selected === null ? "Group name" : `Group name (inside "${$("group-title").textContent}")`);
        if (!name) return;
        const g = await api<Group>("/api/groups", { method: "POST", body: { name, parentId: selected } });
        selected = g.id;
        await refresh();
    }),
);
$("btn-rename-group").addEventListener("click", () =>
    attempt(async () => {
        const name = await promptText("Rename group", "Group name", groups.find((g) => g.id === selected)?.name ?? "");
        if (!name) return;
        await api(`/api/groups/${selected}`, { method: "PATCH", body: { name } });
        await refresh();
    }),
);
groupStatus.addEventListener("change", () => attempt(() => api(`/api/groups/${selected}`, { method: "PATCH", body: { status: groupStatus.value } }).then(loadGroups)));
$("btn-delete-group").addEventListener("click", () =>
    attempt(async () => {
        const g = groups.find((x) => x.id === selected);
        if (!g || !confirm(`Delete "${g.name}" with its subgroups and every material in them?`)) return;
        await api(`/api/groups/${g.id}`, { method: "DELETE" });
        selected = g.parentId;
        await refresh();
    }),
);

let timer: ReturnType<typeof setTimeout> | undefined;
for (const input of [q, tag]) {
    input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => void loadMaterials(), 250);
    });
}
type.addEventListener("change", () => void loadMaterials());

await attempt(refresh);
// The dashboard's "Create Study Material" lands here with the form open.
if (new URLSearchParams(location.search).has("new")) {
    history.replaceState(null, "", "/library");
    await attempt(async () => (await createMaterial()) && (await refresh()));
}

// ---- Slide deck upload ------------------------------------------------------

async function saveDeck(file: File): Promise<void> {
    if (!file.name.toLowerCase().endsWith(".pptx")) return fail("Only .pptx files are accepted.");
    if (file.size > MAX_DECK_BYTES) return fail("The deck is larger than 25 MB.");
    await attempt(async () => {
        const name = file.name.replace(/\.pptx$/i, "").trim().slice(0, 200) || "Slide deck";
        const saved = await editMaterial({ deckFile: file, name, groupId: selected });
        if (saved) await refresh();
    });
}

// Drag a .pptx anywhere over the library page, except onto a dialog: the create/edit dialog's own
// upload area should handle a drop there, not start a second upload.
const drop = $("deck-drop");
let dragDepth = 0;
const dialogOpen = () => !!document.querySelector("dialog[open]");
const resetDrop = () => {
    dragDepth = 0;
    drop.classList.add("d-none");
};
window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    if (dialogOpen()) return resetDrop();
    dragDepth++;
    drop.classList.remove("d-none");
});
window.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) resetDrop();
});
window.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    resetDrop();
    if (dialogOpen()) return;
    void saveDeck(e.dataTransfer.files[0]!);
});

// Old "Upload Slide Deck" links land here; open the create dialog instead.
if (new URLSearchParams(location.search).get("upload") === "1") {
    history.replaceState(null, "", "/library");
    await attempt(async () => (await createMaterial({ groupId: selected })) && (await refresh()));
}
