// Read-only slide deck page: /slides?id=123.
import { $, api, errorText, startPage, type Material } from "./common.ts";
import { mountDeckViewer } from "./deck-viewer.ts";

await startPage("library");

const error = $("error");
const title = $("deck-title");
const subtitle = $("deck-subtitle");
const download = $<HTMLAnchorElement>("deck-download");

function fail(e: unknown): void {
    error.textContent = errorText(e);
    error.classList.remove("d-none");
    // There is no file to download when the deck itself couldn't be opened.
    download.classList.add("d-none");
    download.removeAttribute("href");
}

const id = Number(new URLSearchParams(location.search).get("id"));
if (!Number.isInteger(id) || id <= 0) {
    fail("No slide deck was requested. Open one from your library or the community.");
} else {
    try {
        const material = await api<Material>(`/api/materials/${id}`);
        if (material.type !== "Slides") throw new Error("That material is not a slide deck.");
        title.textContent = material.name;
        subtitle.textContent = material.mine ? "Your slide deck, read-only." : `By ${material.author}, read-only.`;
        document.title = `Grade Lake - ${material.name}`;
        download.href = `/api/materials/${id}/download`;
        const viewer = await mountDeckViewer($("viewer"), material, "page");
        window.addEventListener("beforeunload", () => viewer.destroy());
    } catch (e) {
        fail(e);
    }
}
