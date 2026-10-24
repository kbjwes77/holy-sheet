// The shared read-only slide viewer used by /slides and by the library/browse quick preview.
// Navigation, zoom, fullscreen and thumbnail rendering are ours; PPTX parsing and slide DOM
// come from @aiden0z/pptx-renderer's browser build.
import { el, errorText, materialFile, type Material } from "./common.ts";

const RENDERER_URL = "/vendor/pptx-renderer/aiden0z-pptx-renderer.browser.es.js";
type Renderer = typeof import("@aiden0z/pptx-renderer");

let renderer: Promise<Renderer> | null = null;
const loadRenderer = (): Promise<Renderer> => (renderer ??= import(/* @vite-ignore */ RENDERER_URL) as Promise<Renderer>);

export interface DeckViewer {
    destroy(): void;
}

/** Mounts a viewer into `root`; resolves once the deck is rendered. */
export async function mountDeckViewer(root: HTMLElement, material: Material, mode: "page" | "modal"): Promise<DeckViewer> {
    root.replaceChildren();
    root.classList.add("deck-viewer", `deck-viewer-${mode}`);

    const sidebar = mode === "page" ? el("div", "deck-sidebar") : null;
    const main = el("div", "deck-main");
    const toolbar = el("div", "deck-toolbar");
    const stageWrap = el("div", "deck-stage-wrap");
    const stage = el("div", "deck-stage");
    stageWrap.append(stage);
    main.append(toolbar, stageWrap);
    if (sidebar) root.append(sidebar, main);
    else root.append(main);

    const prev = iconButton("bi-chevron-left", "Previous slide");
    const next = iconButton("bi-chevron-right", "Next slide");
    const counter = el("span", "small fw-medium px-2", "1 / 1");
    const zoomOut = iconButton("bi-zoom-out", "Zoom out");
    const zoomIn = iconButton("bi-zoom-in", "Zoom in");
    const zoomLabel = el("span", "small fg-secondary", "100%");
    const fit = iconButton("bi-arrows-angle-contract", "Fit slide");
    const present = iconButton("bi-fullscreen", "Present fullscreen");
    toolbar.append(prev, next, counter);
    if (mode === "page") toolbar.append(el("span", "ms-auto"), zoomOut, zoomLabel, zoomIn, fit, present);

    const status = el("div", "deck-status", "Loading slides…");
    stageWrap.append(status);

    let viewer: import("@aiden0z/pptx-renderer").PptxViewer | null = null;
    let zoom = 100;
    let thumbs: import("@aiden0z/pptx-renderer").SlideHandle[] = [];
    let thumbObserver: IntersectionObserver | null = null;
    let destroyed = false;
    let ready = false;
    let slideError = false;

    const clamp = (n: number) => Math.max(0, Math.min(n, (viewer?.slideCount ?? 1) - 1));
    const go = (index: number) => void viewer?.goToSlide(clamp(index));

    function paint(index: number): void {
        const count = viewer?.slideCount ?? 1;
        counter.textContent = `${index + 1} / ${count}`;
        for (const button of sidebar?.querySelectorAll<HTMLElement>("[data-slide]") ?? []) {
            const active = Number(button.dataset.slide) === index;
            button.classList.toggle("active", active);
            if (active) button.scrollIntoView({ block: "nearest" });
        }
    }

    prev.addEventListener("click", () => go((viewer?.currentSlideIndex ?? 0) - 1));
    next.addEventListener("click", () => go((viewer?.currentSlideIndex ?? 0) + 1));
    const setZoom = (value: number) => {
        zoom = Math.max(10, Math.min(400, Math.round(value)));
        zoomLabel.textContent = `${zoom}%`;
        void viewer?.setZoom(zoom);
    };
    zoomOut.addEventListener("click", () => setZoom(zoom - 25));
    zoomIn.addEventListener("click", () => setZoom(zoom + 25));
    fit.addEventListener("click", () => {
        zoom = 100;
        zoomLabel.textContent = "100%";
        void viewer?.setFitMode("contain");
        void viewer?.setZoom(100);
    });
    present.addEventListener("click", () => {
        if (!document.fullscreenElement) void stageWrap.requestFullscreen().catch(() => {});
        else void document.exitFullscreen().catch(() => {});
    });
    const onFullscreen = () => {
        present.className = `btn-outline theme-secondary ${document.fullscreenElement ? "bi bi-fullscreen-exit" : "bi bi-fullscreen"}`;
    };
    document.addEventListener("fullscreenchange", onFullscreen);

    const onKey = (e: KeyboardEvent) => {
        if (mode === "modal" && !root.closest("dialog")?.open) return;
        // Leave browser shortcuts (Alt+Left/Right, Ctrl+Home, …) alone.
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const target = e.target as HTMLElement | null;
        if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
        // Space activates a focused button or link; don't steal it.
        if (e.key === " " && target?.closest("button, a, [role='button']")) return;
        if (e.key === "ArrowLeft" || e.key === "PageUp") {
            e.preventDefault();
            go((viewer?.currentSlideIndex ?? 0) - 1);
        } else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
            e.preventDefault();
            go((viewer?.currentSlideIndex ?? 0) + 1);
        } else if (e.key === "Home") {
            e.preventDefault();
            go(0);
        } else if (e.key === "End") {
            e.preventDefault();
            go((viewer?.slideCount ?? 1) - 1);
        }
    };
    window.addEventListener("keydown", onKey);

    try {
        const mod = await loadRenderer();
        if (destroyed) throw new Error("closed");
        const buffer = await materialFile(material.id);
        if (destroyed) throw new Error("closed");
        viewer = await mod.PptxViewer.open(buffer, stage, {
            renderMode: "slide",
            zipLimits: mod.RECOMMENDED_ZIP_LIMITS,
            externalMedia: "block",
            lazySlides: true,
            lazyMedia: true,
            onSlideChange: (index) => {
                // A slide's error is about that slide; clear it once a different one renders.
                if (ready && slideError) {
                    slideError = false;
                    status.classList.add("d-none");
                }
                paint(index);
            },
            onSlideError: (_index, error) => {
                slideError = true;
                status.textContent = `This slide couldn't be rendered: ${errorText(error)}`;
                status.classList.remove("d-none");
            },
        });
        if (destroyed) throw new Error("closed");
        ready = true;
        if (!slideError) status.classList.add("d-none");
        void viewer.setZoom(zoom);

        if (sidebar) {
            const buttons: HTMLElement[] = [];
            const pending: number[] = [];
            let activeThumbs = 0;
            const pump = () => {
                while (activeThumbs < 2 && pending.length) {
                    // Closing the viewer mid-load can leave queued thumbnails behind.
                    if (destroyed || !viewer) return;
                    const i = pending.shift()!;
                    const mini = buttons[i]!.querySelector<HTMLElement>(".deck-thumb-mini");
                    if (!mini) continue;
                    activeThumbs++;
                    let handle: import("@aiden0z/pptx-renderer").SlideHandle | null = null;
                    try {
                        handle = viewer.renderThumbnailToContainer(i, mini, { width: 128 });
                    } catch {
                        activeThumbs--;
                        continue;
                    }
                    if (handle) thumbs.push(handle);
                    void (handle?.ready ?? Promise.resolve())
                        .catch(() => {})
                        .finally(() => {
                            activeThumbs--;
                            pump();
                        });
                }
            };
            for (let i = 0; i < viewer.slideCount; i++) {
                const b = el("button", "deck-thumbnail");
                b.type = "button";
                b.dataset.slide = String(i);
                b.append(el("span", "deck-thumb-num", String(i + 1)), el("span", "deck-thumb-mini"));
                b.addEventListener("click", () => go(i));
                buttons.push(b);
                sidebar.append(b);
            }
            thumbObserver = new IntersectionObserver(
                (entries) => {
                    if (destroyed) return;
                    for (const entry of entries) {
                        if (!entry.isIntersecting) continue;
                        const b = entry.target as HTMLElement;
                        thumbObserver!.unobserve(b);
                        pending.push(Number(b.dataset.slide));
                        pump();
                    }
                },
                { root: sidebar, rootMargin: "200px" },
            );
            for (const b of buttons) thumbObserver.observe(b);
        }
        paint(viewer.currentSlideIndex);
    } catch (e) {
        if (destroyed) return { destroy() {} };
        status.textContent = `Couldn't open this deck: ${errorText(e)}`;
        status.classList.add("theme-danger");
        prev.disabled = next.disabled = zoomOut.disabled = zoomIn.disabled = fit.disabled = present.disabled = true;
    }

    return {
        destroy() {
            destroyed = true;
            window.removeEventListener("keydown", onKey);
            document.removeEventListener("fullscreenchange", onFullscreen);
            thumbObserver?.disconnect();
            for (const t of thumbs) t.dispose();
            thumbs = [];
            viewer?.destroy();
            viewer = null;
            root.replaceChildren();
        },
    };
}

function iconButton(icon: string, label: string): HTMLButtonElement {
    const b = el("button", `btn-outline theme-secondary bi ${icon}`);
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    return b;
}
