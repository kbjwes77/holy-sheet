import { $, api, el, errorText, MATERIAL_TYPES, startPage, STATUSES, type Group, type Material } from "./common.ts";
import { editMaterial, promptText } from "./library-dialogs.ts";
import { button, downloadMaterial, materialRow, typeFilter } from "./materials-list.ts";

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
        $("materials").replaceChildren(
            ...materials.map((m) =>
                materialRow(m, [
                    button("bi-pencil", "Edit", () => attempt(async () => (await editMaterial({ material: m, askContent: true })) && (await refresh()))),
                    button("bi-download", "Download JSON", () => attempt(() => downloadMaterial(m))),
                    button("bi-ui-radios-grid", "Open in the Sheet Generator", () => location.assign(`/generator?material=${m.id}`)),
                    button(
                        "bi-trash",
                        "Delete",
                        () =>
                            attempt(async () => {
                                if (!confirm(`Delete "${m.name}"?`)) return;
                                await api(`/api/materials/${m.id}`, { method: "DELETE" });
                                await refresh();
                            }),
                        "theme-danger",
                    ),
                ]),
            ),
        );
        $("count").textContent = total ? `${total} material${total === 1 ? "" : "s"}` : "Nothing here yet. Use New material to add one.";
    });
}

const refresh = async () => {
    await loadGroups();
    await loadMaterials();
};

$("btn-new-material").addEventListener("click", () =>
    attempt(async () => (await editMaterial({ askContent: true, groupId: selected })) && (await refresh())),
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
    await attempt(async () => (await editMaterial({ askContent: true })) && (await refresh()));
}
