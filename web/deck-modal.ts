// Quick preview of a slide deck in a dialog, with a link to the full /slides page.
import { el, type Material } from "./common.ts";
import { openDialog } from "./dialog.ts";
import { mountDeckViewer, type DeckViewer } from "./deck-viewer.ts";

export function previewDeck(material: Material): Promise<void> {
    const open = el("a", "btn-outline theme-secondary btn-sm");
    open.href = `/slides?id=${material.id}`;
    open.innerHTML = '<i class="bi bi-easel me-1"></i>Open full view';

    let viewer: DeckViewer | null = null;
    let closed = false;
    const done = openDialog<void>({ title: material.name, size: "xl", actions: [open] }, (body) => {
        void mountDeckViewer(body, material, "modal")
            .then((v) => {
                viewer = v;
                if (closed) v.destroy();
            })
            .catch((e) => {
                if (closed) return;
                body.replaceChildren(el("div", "alert theme-danger", e instanceof Error ? e.message : String(e)));
            });
    });
    return done.then(() => {
        closed = true;
        viewer?.destroy();
        viewer = null;
    });
}
