import { $, api, errorText, MATERIAL_TYPES, startPage, type Material } from "./common.ts";
import { previewDeck } from "./deck-modal.ts";
import { button, copyToLibrary, downloadMaterial, materialRow, typeFilter } from "./materials-list.ts";

await startPage("browse");

const PAGE = 25;
const q = $<HTMLInputElement>("filter-q");
const type = $<HTMLSelectElement>("filter-type");
const tag = $<HTMLInputElement>("filter-tag");
const list = $("materials");
const error = $("error");
typeFilter(type, MATERIAL_TYPES);
let shown = 0;

function fail(e: unknown): void {
    error.textContent = errorText(e);
    error.classList.remove("d-none");
}

async function load(more = false): Promise<void> {
    error.classList.add("d-none");
    if (!more) shown = 0;
    const params = new URLSearchParams({ scope: "community", limit: String(PAGE), offset: String(shown) });
    if (q.value.trim()) params.set("q", q.value.trim());
    if (type.value) params.set("type", type.value);
    for (const t of tag.value.split(",")) if (t.trim()) params.append("tag", t.trim());
    try {
        const { total, materials } = await api<{ total: number; materials: Material[] }>(`/api/materials?${params}`);
        const rows = materials.map((m) => {
            const copy = m.mine
                ? []
                : [
                      button("bi-journal-plus", "Copy to my library", async () => {
                          try {
                              await copyToLibrary(m);
                              location.assign("/library");
                          } catch (e) {
                              fail(e);
                          }
                      }),
                  ];
            if (m.type === "Slides") {
                return materialRow(m, [
                    button("bi-eye", "Preview", () => previewDeck(m).catch(fail)),
                    button("bi-easel", "Open full view", () => location.assign(`/slides?id=${m.id}`)),
                    button("bi-download", "Download .pptx", () => downloadMaterial(m).catch(fail)),
                    ...copy,
                ]);
            }
            return materialRow(m, [
                button("bi-download", "Download JSON", () => downloadMaterial(m).catch(fail)),
                button("bi-ui-radios-grid", "Open in Print Sheets", () => location.assign(`/generator?material=${m.id}`)),
                ...copy,
            ]);
        });
        if (more) list.append(...rows);
        else list.replaceChildren(...rows);
        shown += materials.length;
        $("count").textContent = total ? `Showing ${shown} of ${total}` : "No published materials match.";
        $("btn-more").classList.toggle("d-none", shown >= total);
    } catch (e) {
        fail(e);
    }
}

let timer: ReturnType<typeof setTimeout> | undefined;
for (const input of [q, tag]) {
    input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 250);
    });
}
type.addEventListener("change", () => void load());
$("btn-more").addEventListener("click", () => void load(true));
void load();
