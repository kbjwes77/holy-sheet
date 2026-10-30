// The "Write questions with an AI chatbot" dialog: a few choices build a prompt (ai-prompt.ts) to copy into any chatbot,
// with the steps spelled out for someone who has never done this.
import { buildPrompt, DEFAULTS, type Kind, type PromptOptions, type Style } from "./ai-prompt.ts";
import { el } from "./common.ts";
import { openDialog } from "./dialog.ts";

// ---- Copying ---------------------------------------------------------------------------------

export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = el("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
    }
}

const CHATBOTS: { name: string; url: string }[] = [
    { name: "Claude", url: "https://claude.ai/new" },
    { name: "ChatGPT", url: "https://chatgpt.com/" },
    { name: "Gemini", url: "https://gemini.google.com/app" },
];

// ---- The dialog ------------------------------------------------------------------------------

function radioRow(name: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLElement {
    const row = el("div", "d-flex flex-wrap gap-4");
    for (const [v, label] of options) {
        const field = el("div", "form-field mb-0");
        const input = el("input", "radio");
        input.type = "radio";
        input.name = name;
        input.id = `${name}-${v}`;
        input.checked = v === value;
        input.addEventListener("change", () => input.checked && onChange(v));
        const l = el("label", "", label);
        l.htmlFor = input.id;
        field.append(input, l);
        row.append(field);
    }
    return row;
}

function group(label: string, control: HTMLElement, hint = ""): HTMLElement {
    const wrap = el("div", "mb-4");
    wrap.append(el("div", "form-label fw-medium", label), control);
    if (hint) wrap.append(el("div", "form-text", hint));
    return wrap;
}

/**
 * Opens the "Write it with AI" dialog: a few choices build a prompt to copy into any chatbot, with the steps spelled out
 * for someone who has never done this. Resolves when the dialog closes.
 */
export function openAiPrompt(): Promise<unknown> {
    const o: PromptOptions = { ...DEFAULTS };
    return openDialog<true>({ title: "Write questions with an AI chatbot", size: "lg" }, (body, footer) => {
        const intro = el("p", "mb-4");
        intro.innerHTML =
            "Chatbots like Claude, ChatGPT and Gemini can write a whole test for you. Grade Lake reads a simple text format called <strong>Test JSON</strong>, " +
            "so this builds a prompt that teaches the chatbot that format. Three steps:";
        const steps = el("ol", "small mb-5 ps-5");
        steps.innerHTML =
            "<li>Describe your test below, then <strong>copy the prompt</strong>.</li>" +
            "<li>Paste it into a chatbot and send it. Check the questions it writes; ask it to change anything you don't like.</li>" +
            "<li>Copy its reply (the code block is enough, extra chatter is removed for you) and paste it into the <strong>Test JSON</strong> box.</li>";

        const topic = el("input", "form-control");
        topic.id = "ai-topic";
        topic.placeholder = "e.g. photosynthesis, the French Revolution, solving two-step equations";
        topic.maxLength = 300;
        const audience = el("input", "form-control");
        audience.id = "ai-audience";
        audience.placeholder = "e.g. 9th grade biology, AP Macroeconomics, adult beginners";
        audience.maxLength = 200;
        const count = el("input", "form-control w-auto");
        count.id = "ai-count";
        count.type = "number";
        count.min = "1";
        count.max = "100";
        count.value = String(o.count);
        const notes = el("textarea", "form-control");
        notes.id = "ai-notes";
        notes.rows = 2;
        notes.placeholder = "Optional: topics to include or skip, difficulty, a textbook chapter, how long the prompts should be…";

        const answers = el("input", "check");
        answers.type = "checkbox";
        answers.id = "ai-answers";
        answers.checked = o.answers;
        const explanations = el("input", "check");
        explanations.type = "checkbox";
        explanations.id = "ai-explanations";
        const figures = el("input", "check");
        figures.type = "checkbox";
        figures.id = "ai-figures";
        const check = (input: HTMLInputElement, label: string, hint: string) => {
            const f = el("div", "form-field mb-1");
            const l = el("label", "", label);
            l.htmlFor = input.id;
            f.append(input, l);
            const wrap = el("div");
            wrap.append(f, el("small", "form-text d-block ms-6 mb-2", hint));
            return wrap;
        };

        const preview = el("textarea", "form-control font-monospace");
        preview.id = "ai-preview";
        preview.rows = 9;
        preview.readOnly = true;
        preview.spellcheck = false;
        preview.setAttribute("aria-label", "Prompt to copy");

        const answersBox = check(answers, "Include the answers", "Needed to grade a quiz or exam. A study guide always includes them.");
        const sync = () => {
            o.topic = topic.value;
            o.audience = audience.value;
            o.count = Number(count.value);
            o.notes = notes.value;
            o.answers = answers.checked;
            o.explanations = explanations.checked;
            o.figures = figures.checked;
            // A study guide always carries its answers.
            answers.disabled = o.kind === "Study Guide";
            if (answers.disabled) answers.checked = true;
            preview.value = buildPrompt({ ...o, answers: answers.checked });
        };
        for (const input of [topic, audience, count, notes, answers, explanations, figures]) input.addEventListener("input", sync);

        const kind = radioRow(
            "ai-kind",
            [
                ["Quiz", "Quiz"],
                ["Exam", "Exam"],
                ["Study Guide", "Study guide"],
            ],
            o.kind,
            (v) => {
                o.kind = v as Kind;
                sync();
            },
        );
        const style = radioRow(
            "ai-style",
            [
                ["mc", "Multiple choice"],
                ["multi", "Some with several right answers"],
                ["free", "Written answers"],
                ["mix", "A mix"],
            ],
            o.style,
            (v) => {
                o.style = v as Style;
                sync();
            },
        );

        const row = el("div", "row g-4");
        const col = (c: HTMLElement) => {
            const d = el("div", "col-12 sm:col-6");
            d.append(c);
            return d;
        };
        row.append(col(group("Topic", topic)), col(group("Who is it for?", audience, "Optional, but helps the chatbot pitch the difficulty.")));

        const copyIcon = el("i", "bi bi-clipboard me-1");
        const copy = el("button", "btn-solid theme-primary");
        copy.type = "button";
        copy.append(copyIcon, "Copy prompt");
        const copied = el("span", "small fg-success d-none", "Copied. Now paste it into a chatbot.");
        const flash = () => {
            copyIcon.className = "bi bi-clipboard-check me-1";
            copied.classList.remove("d-none");
            setTimeout(() => {
                copyIcon.className = "bi bi-clipboard me-1";
                copied.classList.add("d-none");
            }, 3500);
        };
        copy.addEventListener("click", async () => {
            if (await copyText(preview.value)) flash();
        });
        const open = el("div", "d-flex flex-wrap align-items-center gap-2");
        open.append(el("span", "small fg-secondary", "Copy it and open:"));
        for (const bot of CHATBOTS) {
            const a = el("a", "btn-sm btn-outline theme-secondary");
            a.href = bot.url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.append(bot.name, el("i", "bi bi-box-arrow-up-right ms-1"));
            // Chatbots can't take a long prompt in a link, so copy it and open the site to paste into.
            a.addEventListener("click", async () => {
                if (await copyText(preview.value)) flash();
            });
            open.append(a);
        }
        footer.classList.add("flex-wrap", "justify-content-start", "gap-3");
        footer.append(copy, open, copied);

        const adv = el("details", "mb-4");
        adv.append(el("summary", "small fg-secondary", "Add figures, explanations or a custom request"));
        const advBody = el("div", "mt-3");
        advBody.append(
            check(explanations, "Include explanations", "A sentence on why each answer is right. They print in a study guide's solutions and a Teacher's Copy."),
            check(figures, "Include graphs, diagrams or tables", "The chatbot draws them as SVG or HTML tables. Check how they look in the preview; simple ones work best."),
            group("Anything else?", notes),
        );
        adv.append(advBody);

        const note = el("p", "small fg-secondary mb-0 mt-3");
        note.innerHTML =
            '<i class="bi bi-lightbulb me-1"></i>Tip: always read the questions before you print. Chatbots occasionally get an answer wrong, ' +
            "and a wrong answer in the key marks students down.";

        body.append(
            intro,
            steps,
            row,
            group("What kind of test?", kind),
            group("Question style", style),
            group("How many questions?", count),
            answersBox,
            adv,
            group("Your prompt", preview, "Updates as you change the choices above."),
            note,
        );
        sync();
        return topic;
    });
}
