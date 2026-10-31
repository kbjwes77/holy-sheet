import { openAiPrompt } from "./ai-dialog.ts";
import { $, api, el, errorText, startPage } from "./common.ts";

const { me, motd } = await startPage("dashboard");

$("name").textContent = me.displayName;
const { gradeRunsThisMonth: runs, pagesThisMonth, pageLimit } = me.usage;
const pagesLeft = pageLimit === null ? "" : ` · ${Math.max(0, pageLimit - pagesThisMonth).toLocaleString()} of ${pageLimit.toLocaleString()} pages left`;
$("plan-line").textContent = `${me.plan === "pro" ? "Pro plan" : "Free plan"}${me.canGrade ? ` · ${runs} grading run${runs === 1 ? "" : "s"} this month${pagesLeft}` : " · grading needs a Pro plan"}`;

if (new URLSearchParams(location.search).get("subscribed") === "1") $("subscribed").classList.remove("d-none");

let currentMotd = motd;
function showMotd(text: string): void {
    currentMotd = text;
    $("motd").textContent = text || "Nothing new today.";
}
showMotd(motd);

if (me.isAdmin) {
    const form = $<HTMLFormElement>("motd-form");
    const input = $<HTMLTextAreaElement>("motd-input");
    const edit = $("btn-edit-motd");
    edit.classList.remove("d-none");
    const toggle = (open: boolean) => {
        form.classList.toggle("d-none", !open);
        edit.classList.toggle("d-none", open);
        if (open) {
            input.value = currentMotd;
            input.focus();
        }
    };
    edit.addEventListener("click", () => toggle(true));
    $("btn-cancel-motd").addEventListener("click", () => toggle(false));
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            showMotd((await api<{ motd: string }>("/api/motd", { method: "PUT", body: { motd: input.value } })).motd);
            toggle(false);
        } catch (err) {
            alert(errorText(err));
        }
    });
}

// The first-run guide stays until it is dismissed (remembered in this browser).
const START_KEY = "dashboard.hide-get-started";
try {
    if (localStorage.getItem(START_KEY) === "1") $("get-started").classList.add("d-none");
} catch {
    // Storage unavailable: always show it.
}
$("btn-hide-start").addEventListener("click", () => {
    $("get-started").classList.add("d-none");
    try {
        localStorage.setItem(START_KEY, "1");
    } catch {
        // Not remembered.
    }
});
$("btn-ai-prompt").addEventListener("click", () => void openAiPrompt());

// The tiles, in the order you'd use them. An entry with a handler opens a dialog instead of a page.
const tiles: [string | (() => void), string, string, string, string][] = [
    [() => void openAiPrompt(), "bi-stars", "Write Questions with AI", "Get a prompt that has Claude, ChatGPT or Gemini write a quiz, exam or study guide for you.", "accent"],
    ["/generator", "bi-ui-radios-grid", "Print Sheets", "Turn your questions into printable study guides, quizzes and exams with scannable answer sheets.", "warning"],
    ["/grader", "bi-clipboard-check", "Grade Sheets", me.canGrade ? "Scan finished answer sheets and get every score." : "Scan finished answer sheets and get every score (Pro plan).", "primary"],
    ["/library?new=1", "bi-plus-circle", "Create Study Material", "Upload slides, or write a study guide, quiz or exam and save it to your library.", "info"],
    ["/library", "bi-collection", "My Library", "Your saved materials, arranged in nested groups, with a choice of what to publish.", "info"],
    ["/browse", "bi-globe2", "Browse the Community", "View and download materials published by other users.", "success"],
];
$("tiles").replaceChildren(
    ...tiles.map(([href, icon, title, text, tint]) => {
        const col = el("div", "md:col-6 lg:col-4");
        const a = el("a", "card shadow-sm h-100 text-decoration-none hover-lift");
        if (typeof href === "string") a.href = href;
        else {
            a.href = "#";
            a.addEventListener("click", (e) => {
                e.preventDefault();
                href();
            });
        }
        const body = el("div", "card-body");
        const h = el("h2", "h5 d-flex align-items-center gap-3 mb-3");
        h.innerHTML = `<span class="tile-icon tint-${tint}"><i class="bi ${icon}"></i></span>`;
        h.append(title);
        body.append(h, el("p", "mb-0 fg-secondary", text));
        a.append(body);
        col.append(a);
        return col;
    }),
);
