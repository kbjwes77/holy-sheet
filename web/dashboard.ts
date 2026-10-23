import { $, api, el, errorText, startPage } from "./common.ts";

const { me, motd } = await startPage("dashboard");

$("name").textContent = me.displayName;
const runs = me.usage.gradeRunsThisMonth;
$("plan-line").textContent = `${me.plan === "pro" ? "Pro plan" : "Free plan"}${me.canGrade ? ` · ${runs} grading run${runs === 1 ? "" : "s"} this month` : " · grading needs a Pro plan"}`;

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

const tiles: [string, string, string, string, string][] = [
    ["/library?new=1", "bi-plus-circle", "Create Study Material", "Write or paste a worksheet, quiz, exam or study guide and save it.", "primary"],
    ["/library", "bi-collection", "Organize into Groups", "Arrange your materials in nested groups and choose what to publish.", "info"],
    ["/browse", "bi-globe2", "Browse the Community", "View and download materials published by other users.", "success"],
    ["/generator", "bi-ui-radios-grid", "Sheet Generator", "Turn a test into a printable answer sheet the grader can read.", "warning"],
    ["/grader", "bi-clipboard-check", "Grader", me.canGrade ? "Grade scanned answer sheets." : "Grade scanned answer sheets (Pro plan).", "accent"],
];
$("tiles").replaceChildren(
    ...tiles.map(([href, icon, title, text, tint]) => {
        const col = el("div", "md:col-6 lg:col-4");
        const a = el("a", "card shadow-sm h-100 text-decoration-none hover-lift");
        a.href = href;
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
