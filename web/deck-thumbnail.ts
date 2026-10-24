// Lazy first-slide thumbnails for Slides rows. The renderer is large, so it is imported only
// when a deck actually scrolls into view, and at most two decks are parsed at once. A parsed
// deck stays alive (capped, LRU) because its thumbnail can contain blob-backed images.
import { errorText, materialFile, type Material } from "./common.ts";

const RENDERER_URL = "/vendor/pptx-renderer/aiden0z-pptx-renderer.browser.es.js";
type Renderer = typeof import("@aiden0z/pptx-renderer");

let loading: Promise<Renderer> | null = null;
const loadRenderer = (): Promise<Renderer> => (loading ??= import(/* @vite-ignore */ RENDERER_URL) as Promise<Renderer>);

interface Entry {
    key: string;
    viewer: import("@aiden0z/pptx-renderer").PptxViewer;
    host: HTMLDivElement;
    handles: import("@aiden0z/pptx-renderer").SlideHandle[];
    dispose: () => void;
}

const cache = new Map<number, Entry>();
/** A parse already under way, shared by every row that asks for the same deck. */
const inflight = new Map<number, { key: string; promise: Promise<Entry> }>();
const MAX_CACHED = 8;
const MAX_PARALLEL = 2;
let running = 0;
const queue: (() => Promise<void>)[] = [];

function pump(): void {
    while (running < MAX_PARALLEL && queue.length) {
        const job = queue.shift()!;
        running++;
        void job().finally(() => {
            running--;
            pump();
        });
    }
}

function trimCache(): void {
    for (const [id, entry] of [...cache]) {
        if (cache.size <= MAX_CACHED) return;
        // Never tear down a thumbnail whose slide is still on screen (or hasn't rendered yet):
        // disposing revokes its blob URLs and leaves a blank box.
        if (!entry.handles.length || entry.handles.some((h) => h.element.isConnected)) continue;
        entry.dispose();
        cache.delete(id);
    }
}

const observer = new IntersectionObserver(
    (entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target as HTMLElement;
            observer.unobserve(el);
            const material = (el as HTMLElement & { __deck?: Material }).__deck;
            if (!material) continue;
            const job = () => renderThumbnail(el, material);
            if (running < MAX_PARALLEL) {
                running++;
                void job().finally(() => {
                    running--;
                    pump();
                });
            } else {
                queue.push(job);
            }
        }
    },
    { rootMargin: "250px" },
);

/** Starts observing a row's thumbnail container; rendering begins when it nears the viewport. */
export function attachDeckThumbnail(container: HTMLElement, material: Material): void {
    container.classList.add("deck-thumb");
    container.innerHTML = '<i class="bi bi-easel deck-thumb-fallback" aria-hidden="true"></i><div class="deck-thumb-slide"></div>';
    (container as HTMLElement & { __deck?: Material }).__deck = material;
    observer.observe(container);
}

async function buildEntry(material: Material, key: string): Promise<Entry> {
    const mod = await loadRenderer();
    const buffer = await materialFile(material.id);
    const files = await mod.parseZipLazyMedia(buffer, mod.RECOMMENDED_ZIP_LIMITS);
    const presentation = mod.buildPresentation(files, { lazySlides: true });
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-10000px;top:0;width:960px;height:540px;pointer-events:none";
    let viewer: import("@aiden0z/pptx-renderer").PptxViewer | null = null;
    const handles: import("@aiden0z/pptx-renderer").SlideHandle[] = [];
    try {
        document.body.append(host);
        viewer = new mod.PptxViewer(host, { externalMedia: "block" });
        viewer.load(presentation);
        const entry: Entry = {
            key,
            viewer,
            host,
            handles,
            dispose: () => {
                for (const h of entry.handles) h.dispose();
                viewer!.destroy();
                host.remove();
            },
        };
        cache.set(material.id, entry);
        trimCache();
        return entry;
    } catch (e) {
        for (const h of handles) h.dispose();
        viewer?.destroy();
        host.remove();
        throw e;
    }
}

async function getEntry(material: Material): Promise<Entry> {
    const key = `${material.id}:${material.updatedAt}`;
    const hit = cache.get(material.id);
    if (hit?.key === key) {
        // Refresh LRU position.
        cache.delete(material.id);
        cache.set(material.id, hit);
        return hit;
    }
    if (hit) {
        hit.dispose();
        cache.delete(material.id);
    }

    const already = inflight.get(material.id);
    if (already?.key === key) return already.promise;

    let promise: Promise<Entry>;
    promise = buildEntry(material, key).finally(() => {
        if (inflight.get(material.id)?.promise === promise) inflight.delete(material.id);
    });
    inflight.set(material.id, { key, promise });
    return promise;
}

async function renderThumbnail(container: HTMLElement, material: Material): Promise<void> {
    const target = container.querySelector<HTMLElement>(".deck-thumb-slide");
    if (!target) return;
    try {
        const entry = await getEntry(material);
        // The list may have been replaced while the deck was parsing.
        if (!target.isConnected) return;
        const handle = entry.viewer.renderThumbnailToContainer(0, target, { width: 88 });
        if (!handle) throw new Error("no first slide");
        entry.handles.push(handle);
        await handle.ready;
        container.classList.add("is-ready");
    } catch (e) {
        container.classList.add("is-error");
        container.title = errorText(e);
    }
}
