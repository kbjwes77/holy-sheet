import { describe, expect, test } from "bun:test";
import { parseSheetJson } from "../gen/testdef.ts";
import { buildPrompt, DEFAULTS, extractJson, FIGURE_RULES, FORMAT_RULES, formatGuideForAi, MINI_EXAMPLE } from "../web/ai-prompt.ts";

const quiz = { test: "Photosynthesis Quiz", type: "Quiz", questions: [{ prompt: "Which gas do plants take in?", choices: ["Oxygen", "Carbon dioxide"], answer: "B" }] };

describe("extractJson", () => {
    test("leaves JSON that already parses alone", () => {
        const text = JSON.stringify(quiz);
        expect(extractJson(text)).toEqual({ text, cleaned: false });
    });

    test("takes the JSON out of a fenced reply with chatter around it", () => {
        const reply = `Sure! Here's your quiz:\n\n\`\`\`json\n${JSON.stringify(quiz, null, 2)}\n\`\`\`\n\nLet me know if you'd like changes!`;
        const r = extractJson(reply);
        expect(r.cleaned).toBe(true);
        expect(JSON.parse(r.text)).toEqual(quiz);
    });

    test("handles a fence with no language, CRLF line endings and an unterminated fence", () => {
        const body = JSON.stringify(quiz, null, 2).replace(/\n/g, "\r\n");
        expect(JSON.parse(extractJson(`\`\`\`\r\n${body}\r\n\`\`\``).text)).toEqual(quiz);
        expect(JSON.parse(extractJson(`Here you go:\n\`\`\`json\n${body}`).text)).toEqual(quiz);
    });

    test("finds loose JSON between the first { and the last }", () => {
        const r = extractJson(`Here is the test: ${JSON.stringify(quiz)} Enjoy!`);
        expect(r.cleaned).toBe(true);
        expect(JSON.parse(r.text)).toEqual(quiz);
    });

    test("picks the fenced block that is the JSON, not a code sample in the chatter", () => {
        const reply = `Use \`\`\`x = 1\`\`\` carefully.\n\`\`\`json\n${JSON.stringify(quiz)}\n\`\`\``;
        expect(JSON.parse(extractJson(reply).text)).toEqual(quiz);
    });

    test("repairs curly quotes that a chat app swapped in", () => {
        const curly = JSON.stringify(quiz).replace(/"/g, "“");
        // Every quote is curly, so it only parses once straightened.
        expect(JSON.parse(extractJson(`\`\`\`json\n${curly}\n\`\`\``).text)).toEqual(quiz);
    });

    test("returns text it cannot fix unchanged, so the validator can explain what is wrong", () => {
        for (const text of ["", "   ", "no json here", '{"test": "x", "questions": [', "{'test': 'x'}"]) {
            expect(extractJson(text)).toEqual({ text, cleaned: false });
        }
    });
});

describe("the format as told to the chatbot", () => {
    /** The example object in the rules, with its explanatory // notes removed. */
    function exampleFromRules(): unknown {
        const start = FORMAT_RULES.indexOf("{");
        const end = FORMAT_RULES.indexOf("\n}\n", start) + 2;
        const json = FORMAT_RULES.slice(start, end).replace(/\s+\/\/.*$/gm, "");
        return JSON.parse(json);
    }

    test("the example in the rules is a valid test, and grades", () => {
        const r = parseSheetJson(JSON.stringify(exampleFromRules()), { layout: false });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.sheetType).toBe("Quiz");
            expect(r.grading).not.toBeNull();
        }
    });

    test("the built-in example test is valid too", () => {
        const r = parseSheetJson(MINI_EXAMPLE);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.test.questions).toHaveLength(3);
    });

    test("the figure rules' examples (an SVG and a table) are valid when questions use them", () => {
        const start = FIGURE_RULES.indexOf('"figures": {');
        const end = FIGURE_RULES.indexOf("\n  }\n", start) + 4;
        const { figures } = JSON.parse(`{${FIGURE_RULES.slice(start, end)}}`);
        const questions = [{ prompt: "Read the graph.", figures: ["demand", "prices"], choices: ["a", "b"] }];
        const r = parseSheetJson(JSON.stringify({ test: "Figs", questions, figures }), { layout: false });
        expect(r.ok ? [] : r.errors).toEqual([]);
        expect(r.ok).toBe(true);
    });

    test("names every key the validator accepts, and tells the chatbot the printing limits", () => {
        for (const key of ["test", "type", "questions", "prompt", "choices", "answer", "explanation", "rubric", "points", "lines", "Free Response", "Study Guide"]) {
            expect(FORMAT_RULES).toContain(`"${key}"`);
        }
        expect(FORMAT_RULES).toContain("Do NOT start them with");
        expect(FORMAT_RULES).toContain("Greek letters");
    });

    test("the format-only message wraps the rules for pasting before a request", () => {
        const g = formatGuideForAi();
        expect(g).toContain(FORMAT_RULES);
        expect(g).toContain(FIGURE_RULES);
    });
});

describe("buildPrompt", () => {
    test("states the task first and the rules after", () => {
        const p = buildPrompt({ ...DEFAULTS, topic: "photosynthesis", audience: "9th grade biology", count: 12 });
        expect(p.startsWith("Write a quiz on photosynthesis for 9th grade biology")).toBe(true);
        expect(p).toContain("12 questions");
        expect(p).toContain('Set "type" to "Quiz"');
        expect(p.indexOf("12 questions")).toBeLessThan(p.indexOf("Output format"));
        expect(p).not.toContain("Figures:");
    });

    test("leaves a visible placeholder when no topic was given", () => {
        expect(buildPrompt(DEFAULTS)).toContain("[TOPIC");
    });

    test("an exam is typed as an exam; written answers and mixes ask for Free Response", () => {
        expect(buildPrompt({ ...DEFAULTS, kind: "Exam" })).toContain('Set "type" to "Exam"');
        expect(buildPrompt({ ...DEFAULTS, style: "free" })).toContain('"Free Response"');
        expect(buildPrompt({ ...DEFAULTS, style: "mix" })).toContain("Free Response");
        expect(buildPrompt({ ...DEFAULTS, style: "multi" })).toContain("Select all that apply");
    });

    test("a study guide always asks for answers, even when the box is unticked", () => {
        const p = buildPrompt({ ...DEFAULTS, kind: "Study Guide", answers: false });
        expect(p).toContain('"Study Guide"');
        expect(p).toContain('Include an "answer" on every question');
        expect(p).not.toContain("Leave out every");
    });

    test("without answers it says so; with explanations and figures it adds them", () => {
        expect(buildPrompt({ ...DEFAULTS, answers: false })).toContain('Leave out every "answer"');
        const p = buildPrompt({ ...DEFAULTS, explanations: true, figures: true, notes: "Focus on chapter 3.\nSkip lab safety." });
        expect(p).toContain('"explanation" on every question');
        expect(p).toContain("Figures:");
        expect(p).toContain("Focus on chapter 3. Skip lab safety.");
    });

    test("a nonsense count still asks for at least one question", () => {
        expect(buildPrompt({ ...DEFAULTS, count: Number.NaN })).toContain("1 questions");
        expect(buildPrompt({ ...DEFAULTS, count: 0 })).toContain("1 questions");
    });
});
