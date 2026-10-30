// Results: the user's saved grading runs, newest first. Each opens in the grader's Results step
// (/grader?run=<id>), and its CSV (with any curve) downloads from the server.
import { $, api, el, errorText, startPage } from "./common.ts";
import { promptText } from "./library-dialogs.ts";
import { button } from "./materials-list.ts";

await startPage("results");

interface Run {
    id: number;
    name: string;
    status: "running" | "graded" | "partial" | "failed" | "cancelled" | "interrupted";
    students: number;
    average: number | null;
    createdAt: number;
}

const STATUS: Record<Run["status"], [theme: string, label: string]> = {
    running: ["theme-info", "In progress"],
    graded: ["theme-success", "Graded"],
    partial: ["theme-warning", "Some skipped"],
    failed: ["theme-danger", "Failed"],
    cancelled: ["theme-secondary", "Cancelled"],
    interrupted: ["theme-danger", "Interrupted"],
};

const error = $("error");
let runs: Run[] = [];
let total = 0;

function fail(e: unknown): void {
    error.textContent = errorText(e);
    error.classList.remove("d-none");
}

async function attempt(fn: () => Promise<unknown>): Promise<void> {
    error.classList.add("d-none");
    try {
        await fn();
    } catch (e) {
        fail(e);
    }
}

function render(): void {
    const finished = (r: Run) => r.status !== "running";
    $("runs-table").querySelector("tbody")!.replaceChildren(
        ...runs.map((r) => {
            const tr = el("tr");
            const name = el("td");
            if (finished(r)) {
                const a = el("a", "fw-semibold", r.name);
                a.href = `/grader?run=${r.id}`;
                name.append(a);
            } else name.append(el("span", "fw-semibold", r.name));
            const [theme, label] = STATUS[r.status];
            const status = el("td");
            status.append(el("span", `badge badge-subtle ${theme}`, label));
            const when = new Date(r.createdAt * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
            const actions = el("td", "text-end text-nowrap");
            const group = el("div", "btn-group btn-group-sm");
            if (finished(r)) {
                group.append(
                    button("bi-box-arrow-up-right", "Open", () => location.assign(`/grader?run=${r.id}`)),
                    button("bi-download", "Download CSV", () => location.assign(`/api/grade-runs/${r.id}/csv`)),
                );
            }
            group.append(
                button("bi-pencil", "Rename", () =>
                    attempt(async () => {
                        const name = await promptText("Rename result", "Name", r.name);
                        if (!name?.trim() || name.trim() === r.name) return;
                        await api(`/api/grade-runs/${r.id}`, { method: "PATCH", body: { name: name.trim() } });
                        r.name = name.trim();
                        render();
                    }),
                ),
            );
            if (finished(r)) {
                group.append(
                    button(
                        "bi-trash",
                        "Delete",
                        () =>
                            attempt(async () => {
                                if (!confirm(`Delete the saved result "${r.name}"? Its grades can't be recovered.`)) return;
                                await api(`/api/grade-runs/${r.id}`, { method: "DELETE" });
                                runs = runs.filter((x) => x !== r);
                                total--;
                                render();
                            }),
                        "theme-danger",
                    ),
                );
            }
            actions.append(group);
            tr.append(
                name,
                el("td", "text-nowrap", when),
                el("td", "text-end font-monospace", finished(r) ? String(r.students) : "–"),
                el("td", "text-end font-monospace", r.average === null ? "–" : `${r.average.toFixed(1)}%`),
                status,
                actions,
            );
            return tr;
        }),
    );
    $("runs-empty").classList.toggle("d-none", runs.length > 0);
    $("runs-wrap").classList.toggle("d-none", !runs.length);
    $("count").textContent = total ? `${total} saved result${total === 1 ? "" : "s"}` : "";
    $("btn-more").classList.toggle("d-none", runs.length >= total);
}

async function load(offset: number): Promise<void> {
    await attempt(async () => {
        const page = await api<{ total: number; runs: Run[] }>(`/api/grade-runs?offset=${offset}`);
        total = page.total;
        runs = offset ? [...runs, ...page.runs] : page.runs;
        render();
    });
}

$("btn-more").addEventListener("click", () => void load(runs.length));
await load(0);
