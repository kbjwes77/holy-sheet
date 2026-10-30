import { describe, expect, test } from "bun:test";
import { parseSheetJson } from "../gen/testdef.ts";
import { answerLetters, importDoc, missingAnswers, newQuestion, newState, toDoc } from "../web/free-generator-model.ts";

const valid = (doc: unknown) => parseSheetJson(JSON.stringify(doc), { layout: false });

describe("free generator model", () => {
    test("a filled-in state produces a valid, gradable test", () => {
        const s = newState();
        s.name = "Quiz";
        s.questions[0]!.prompt = "Pick one";
        s.questions[0]!.choices = ["a", "b", "c", "d"];
        s.questions[0]!.correct = [2, 0];
        s.questions[1]!.prompt = "Pick another";
        s.questions[1]!.choices = ["a", "b", "c", "d"];
        s.questions[1]!.correct = [1];
        expect(answerLetters(s.questions[0]!)).toBe("AC");
        const r = valid(toDoc(s));
        expect(r.ok && r.grading).toBeTruthy();
    });

    test("a half-finished state previews with placeholders but saves without invented answers", () => {
        const s = newState();
        expect(missingAnswers(s)).toEqual([1, 2]);
        expect(valid(toDoc(s, { placeholders: true })).ok).toBe(true);
        expect(valid(toDoc(s)).ok).toBe(false);
    });

    test("import then export round-trips, keeping figures and unknown question keys", () => {
        const doc = {
            test: "T",
            type: "Exam",
            figures: { g: { type: "table", content: "<table><tr><td>1</td></tr></table>" } },
            questions: [
                { prompt: "Q1", choices: ["x", "y"], answer: "B", figures: ["g"], explanation: "why" },
                { type: "Free Response", prompt: "Q2", answer: "model", points: 3, lines: 5, rubric: "r" },
            ],
        };
        const s = importDoc(doc)!;
        expect(s.questions[0]!.correct).toEqual([1]);
        expect(s.questions[1]!.points).toBe(3);
        const out = toDoc(s) as typeof doc;
        expect(out.figures).toEqual(doc.figures);
        expect(out.questions[0]).toMatchObject({ prompt: "Q1", answer: "B", figures: ["g"], explanation: "why" });
        expect(out.questions[1]).toMatchObject({ type: "Free Response", answer: "model", points: 3, lines: 5, rubric: "r" });
        expect(valid(out).ok).toBe(true);
    });

    test("removing a question's answers turns the key off on import", () => {
        const s = importDoc({ test: "T", questions: [{ prompt: "Q", choices: ["a", "b"] }] })!;
        expect(s.key).toBe(false);
        expect(importDoc("nope")).toBeNull();
        expect(newQuestion("free").choices).toEqual([]);
    });
});
