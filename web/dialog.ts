// A small wrapper around Bootstrap 6's native <dialog> component: one place that builds the
// .dialog > .dialog-header/.dialog-body/.dialog-footer structure and runs the Dialog plugin.
import Dialog from "bootstrap/js/dist/dialog.js";
import { el } from "./common.ts";

export interface DialogOptions {
    title: string;
    /** Optional size modifier: .dialog-sm, .dialog-lg or .dialog-xl. */
    size?: "sm" | "lg" | "xl";
    /** Extra controls in the header, before the close button (e.g. a link). */
    actions?: HTMLElement[];
    /** Add .dialog-scrollable so a long body scrolls inside the dialog (default true). */
    scrollable?: boolean;
}

/** Builds a dialog's contents; returns the element to focus once it is open. */
export type DialogBody<T> = (body: HTMLElement, footer: HTMLElement, close: (value: T | null) => void) => HTMLElement | void;

let sequence = 0;

/**
 * Opens a modal dialog and resolves with whatever `close(value)` was given, or null when it is
 * dismissed with the close button, Escape, or a backdrop click.
 */
export function openDialog<T>(options: DialogOptions, build: DialogBody<T>): Promise<T | null> {
    return new Promise((resolve) => {
        const titleId = `dialog-title-${++sequence}`;
        const classes = ["dialog"];
        if (options.size) classes.push(`dialog-${options.size}`);
        if (options.scrollable !== false) classes.push("dialog-scrollable");

        const dialog = el("dialog", classes.join(" "));
        dialog.setAttribute("aria-labelledby", titleId);

        const header = el("div", "dialog-header");
        const title = el("h1", "dialog-title", options.title);
        title.id = titleId;
        const closeButton = el("button", "btn-close");
        closeButton.type = "button";
        closeButton.setAttribute("aria-label", "Close");
        closeButton.dataset.bsDismiss = "dialog";
        header.append(title, ...(options.actions ?? []), closeButton);

        const body = el("div", "dialog-body");
        const footer = el("div", "dialog-footer");
        let result: T | null = null;
        const instance = Dialog.getOrCreateInstance(dialog);
        const close = (value: T | null) => {
            result = value;
            void instance.hide();
        };

        const focus = build(body, footer, close);
        dialog.append(header, body);
        if (footer.childNodes.length) dialog.append(footer);
        document.body.append(dialog);

        // The plugin handles Escape, backdrop clicks and the close transition; clean up after it.
        dialog.addEventListener(
            "hidden.bs.dialog",
            () => {
                dialog.remove();
                instance.dispose();
                resolve(result);
            },
            { once: true },
        );

        void instance.show();
        focus?.focus({ preventScroll: true });
    });
}
