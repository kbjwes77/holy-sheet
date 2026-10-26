import { describe, expect, test } from "bun:test";
import { parseSheetJson } from "../gen/testdef.ts";
import { renderTest } from "../gen/sheet.ts";

const doc = (extra: object[] = []) =>
    JSON.stringify({
        test: "Unit 1",
        type: "Quiz",
        questions: [
            { prompt: "Pick", choices: ["a", "b", "c"], answer: "AC", explanation: "Because." },
            { type: "Free Response", prompt: "Explain", answer: "Model answer.", explanation: "Why." },
            ...extra,
        ],
    });

const text = (svgs: string[]) => svgs.join("");

describe("teacher's copy", () => {
    test("is an ungraded inline study guide titled as such", () => {
        const r = parseSheetJson(doc(), { teacherCopy: true });
        if (!r.ok) throw new Error(JSON.stringify(r.errors));
        expect(r.studyGuide).toBe(true);
        expect(r.grading).toBeNull();
        expect(r.test.solutions).toBe("inline");
        expect(r.test.title).toBe("Unit 1 - Teacher's Copy");
    });

    test("fills correct rings and prints FRQ answers and explanations", () => {
        const r = parseSheetJson(doc(), { teacherCopy: true });
        if (!r.ok) throw new Error("invalid");
        const svg = text(renderTest(r.test).map((p) => p.svg));
        expect(svg.match(/<circle[^>]*fill="#000"/g)?.length).toBe(2);
        expect(svg.match(/<circle[^>]*fill="none"/g)?.length).toBe(1);
        expect(svg).toContain("Answer: Model answer.");
        expect(svg).toContain("Explanation: Because.");
        expect(svg).not.toContain("Answer: A)");
    });

    test("explanations can be left out", () => {
        const r = parseSheetJson(doc(), { teacherCopy: true, explanations: false });
        if (!r.ok) throw new Error("invalid");
        const svg = text(renderTest(r.test).map((p) => p.svg));
        expect(svg).not.toContain("Explanation");
        expect(svg).toContain("Answer: Model answer.");
    });

    test("needs an answer for every question", () => {
        const r = parseSheetJson(doc([{ prompt: "No answer", choices: ["x", "y"] }]), { teacherCopy: true });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors[0]!.message).toContain("Missing: 3");
    });

    test("a normal study guide draws no rings", () => {
        const r = parseSheetJson(doc(), { solutions: "inline" });
        if (!r.ok) throw new Error("invalid");
        r.test.studyGuide = true;
        expect(text(renderTest(r.test).map((p) => p.svg))).not.toContain("<circle");
    });
});
