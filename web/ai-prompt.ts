// "Write it with AI", the pure half (no DOM, so it is unit-tested): the prompt that teaches an AI chatbot (Claude, ChatGPT,
// Gemini…) Grade Lake's Test JSON format, and the helper that makes pasting the chatbot's reply forgiving.
//   buildPrompt()     the prompt text for a set of choices
//   extractJson()     pulls the JSON out of a chatbot reply (code fences, "Here's your quiz!" chatter)
// The dialog that uses them is in ai-dialog.ts.

// ---- The format, as the chatbot needs to hear it ---------------------------------------------

/**
 * The rules of the Test JSON format, written for an AI. Keep this in step with gen/testdef.ts: it is the
 * only place the format is explained to a chatbot, so a rule missing here is a rule the chatbot breaks.
 */
export const FORMAT_RULES = `Output format: ONE JSON object, no other keys than these.

{
  "test": "Unit 4 Quiz",                       // required: the title printed on the sheet
  "type": "Quiz",                              // "Quiz", "Exam" or "Study Guide"
  "questions": [
    {
      "prompt": "Which of these is a prime number?",
      "choices": ["9", "15", "17", "21"],      // 2 to 8 choices; letters A, B, C... are added when printed
      "answer": "C",                           // the correct letter(s), e.g. "C", or "AC" if two are correct
      "explanation": "17 has no divisors other than 1 and itself."
    },
    {
      "type": "Free Response",                 // a written answer: no "choices"
      "prompt": "Explain why the sky is blue.",
      "answer": "Air molecules scatter short (blue) wavelengths of sunlight more than long ones.",
      "rubric": "1 point: names scattering. 1 point: says blue light scatters most.",
      "points": 2,                             // whole number 1-100, default 1
      "lines": 4                               // writing lines 1-20, default 3
    }
  ]
}

Rules:
- Reply with the JSON only, in a single code block. No commentary before or after it.
- "choices" are plain text. Do NOT start them with "A)", "B.", "1." and so on, and do not start prompts with a question number. The printer numbers and letters everything.
- "answer" on a multiple-choice question is letters only, matching the order of "choices" (the first choice is A). Vary which letter is correct; do not make them all B or C. Use more than one letter only when the prompt says to select all that apply.
- Give an "answer" on every question or on none of them.
- A "Free Response" question has no "choices". Its "answer" is the model answer a grader compares student writing with, and is required unless the "type" is "Study Guide". "rubric" (what earns each point) is optional.
- "explanation" is optional: why the answer is correct.
- A "Study Guide" is for studying, not grading: its questions may leave out "choices", and its "answer" and "explanation" print as solutions.
- At most 256 questions per test and 2,000 characters per text field. Keep prompts and choices short; a test can print at most 16 pages.
- Make the quotes straight (") and escape any quote inside text as \\". No trailing commas. No comments in the real output (the // notes above are only for you).

Characters: the sheet prints in a standard PDF font. Use only letters, digits, keyboard punctuation, accented Latin letters and these symbols: ° ± × ÷ ² ³ ¼ ½ ¾ µ ¢ £ € § ¶ © ® ™ « » ¿ • – — … ‘ ’ “ ”.
Never use Greek letters (Δ θ π Σ), arrows, math symbols (≤ ≥ ≠ ≈ √ ∞ ∑ ∫), superscripts or subscripts other than ² and ³, or emoji. Spell them out instead: "delta x", "pi", "<=", "x^4", "H2O", "sqrt(x)".`;

/** Extra rules, added when the teacher wants drawings or tables in the questions. */
export const FIGURE_RULES = `
Figures: a question may show a drawing or a table. Define each one once in a top-level "figures" object, keyed by an id (letters, digits, - and _), and list the ids in the question's "figures" array:
  "figures": {
    "demand": { "type": "svg", "content": "<svg viewBox=\\"0 0 200 150\\"><line x1=\\"20\\" y1=\\"20\\" x2=\\"20\\" y2=\\"130\\" stroke=\\"black\\"/><line x1=\\"20\\" y1=\\"130\\" x2=\\"180\\" y2=\\"130\\" stroke=\\"black\\"/></svg>", "width": 2.5, "caption": "Figure 1" },
    "prices": { "type": "table", "content": "<table><tr><th>Price</th><th>Quantity</th></tr><tr><td>$2</td><td>100</td></tr></table>" }
  }
- "type" is "svg" (a graph or drawing) or "table" (an HTML table). "content" is the markup as one JSON string with its quotes escaped as \\". "width" (inches) and "caption" are optional; 3.3 inches or less fits a column.
- SVG: one <svg> with a viewBox; style with attributes (not <style> or class); fonts Arial, Times or Courier only; no scripts, images, links, filters or foreignObject. Draw in black and white; it prints on paper.
- Tables: only <table>, <caption>, <thead>, <tbody>, <tr>, <th>, <td> (colspan, rowspan and align are allowed, and <b>, <i>, <sub>, <sup> inside cells). Every cell is one line and every tag must be closed.
- Only reference figures a question actually needs.`;

/** A small finished test, for "insert an example" and the editor's placeholder. */
export const MINI_EXAMPLE = `{
  "test": "Unit 4 Quiz",
  "type": "Quiz",
  "questions": [
    {
      "prompt": "Which of these is a prime number?",
      "choices": ["9", "15", "17", "21"],
      "answer": "C",
      "explanation": "17 has no divisors other than 1 and itself."
    },
    {
      "prompt": "What is 12 x 8?",
      "choices": ["84", "96", "108", "112"],
      "answer": "B"
    },
    {
      "type": "Free Response",
      "prompt": "Explain what a factor of a number is.",
      "answer": "A whole number that divides the number exactly, with no remainder.",
      "lines": 2
    }
  ]
}
`;

export type Kind = "Quiz" | "Exam" | "Study Guide";
export type Style = "mc" | "multi" | "free" | "mix";

export interface PromptOptions {
    topic: string;
    /** Who it is for, e.g. "9th grade biology". */
    audience: string;
    kind: Kind;
    count: number;
    style: Style;
    /** Include answers (a Quiz or Exam needs them to be graded). */
    answers: boolean;
    explanations: boolean;
    figures: boolean;
    /** Anything else the teacher wants the chatbot to know. */
    notes: string;
}

export const DEFAULTS: PromptOptions = {
    topic: "",
    audience: "",
    kind: "Quiz",
    count: 10,
    style: "mc",
    answers: true,
    explanations: false,
    figures: false,
    notes: "",
};

const STYLE_TEXT: Record<Style, string> = {
    mc: "all multiple choice, each with 4 choices and exactly one correct answer",
    multi: "multiple choice, each with 4 or 5 choices; a few may have more than one correct answer (say \"Select all that apply\" in those prompts)",
    free: 'all "Free Response" (written answers), each with a model "answer" and a short "rubric"',
    mix: 'mostly multiple choice with 4 choices and one correct answer each, plus a few "Free Response" questions at the end',
};

/** The whole prompt: the task first (what the teacher chose), then the format rules. */
export function buildPrompt(o: PromptOptions): string {
    const topic = o.topic.trim() || "[TOPIC: what the test covers]";
    const audience = o.audience.trim();
    const style = o.kind === "Study Guide" && o.style === "mc" ? "multiple choice where it suits, otherwise open-ended questions without choices" : STYLE_TEXT[o.style];
    const lines = [
        `Write a ${o.kind.toLowerCase()} on ${topic}${audience ? ` for ${audience}` : ""}, as a JSON file for the Grade Lake app, which prints it as a worksheet.`,
        "",
        `- ${Math.max(1, Math.round(o.count) || 1)} questions: ${style}.`,
    ];
    if (o.kind === "Study Guide") lines.push('- Set "type" to "Study Guide". It is for studying, so include an "answer" on every question.');
    else lines.push(`- Set "type" to "${o.kind}".`);
    if (o.answers || o.kind === "Study Guide") lines.push('- Include an "answer" on every question.');
    else lines.push('- Leave out every "answer" (I will add them myself).');
    if (o.explanations) lines.push('- Include a one- or two-sentence "explanation" on every question.');
    if (o.figures) lines.push('- Include a figure (graph, diagram or table) where it helps a question, using "figures".');
    if (o.notes.trim()) lines.push(`- ${o.notes.trim().replace(/\n+/g, " ")}`);
    return `${lines.join("\n")}\n\n${FORMAT_RULES}${o.figures ? `\n${FIGURE_RULES}` : ""}\n`;
}

/** The format alone, for pasting into a chat before the teacher describes what they want. */
export function formatGuideForAi(): string {
    return `I'm going to ask you to write tests as JSON for the Grade Lake app. Learn this format first, then wait for my request.\n\n${FORMAT_RULES}\n${FIGURE_RULES}\n`;
}

// ---- Pasting what the chatbot said -----------------------------------------------------------

/**
 * Finds the JSON in a chatbot reply. Chatbots wrap code in ``` fences and add chatter around it; a teacher who selects the
 * whole message pastes all of that. Returns the text unchanged when it already parses, or when no JSON can be found
 * (the validator then explains what's wrong).
 */
export function extractJson(text: string): { text: string; cleaned: boolean } {
    const parses = (s: string) => {
        try {
            JSON.parse(s);
            return true;
        } catch {
            return false;
        }
    };
    const trimmed = text.replace(/^﻿/, "").trim();
    if (!trimmed || parses(trimmed)) return { text, cleaned: false };

    const candidates: string[] = [];
    // A fenced block: ```json … ```
    for (const m of trimmed.matchAll(/```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g)) candidates.push(m[1]!.trim());
    // An unterminated fence (the reply was cut off or half-copied) or loose JSON between the first { and the last }.
    const open = /```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*)$/.exec(trimmed);
    if (open) candidates.push(open[1]!.trim());
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));

    // Curly quotes around JSON keys and values are another habit of chat apps.
    const straight = (s: string) => s.replace(/[“”]/g, '"');
    for (const c of candidates) {
        for (const attempt of [c, straight(c)]) if (parses(attempt)) return { text: `${JSON.stringify(JSON.parse(attempt), null, 2)}\n`, cleaned: true };
    }
    return { text, cleaned: false };
}
