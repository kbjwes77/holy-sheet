import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { csvRow } from "../src/csv.ts";
import { apply, fitAffine, fitHomography, fitHomographyRobust, invert, type Mat3 } from "../src/geometry.ts";
import { scoreAnswers } from "../src/grade.ts";
import { groupPages, type GroupablePage } from "../src/grouping.ts";
import { choiceKey, parseKey } from "../src/key.ts";
import { LAYOUT, bubbleCenter, cellCenter, markerRect, ringRadius } from "../src/layout.ts";
import { CallStats, describeReasoning, fetchModelInfo, gradingPrompt, limitConcurrency, OpenRouterReader, parseNameReply, reasoningFor } from "../src/ocr.ts";
import { blankBaseline } from "../src/pipeline.ts";
import { readZipImages, isPageImage, ZipError } from "../src/zip.ts";

describe("layout", () => {
    test("one bubble per choice row, in a fixed column clear of the markers", () => {
        expect(bubbleCenter(20)).toEqual(cellCenter(LAYOUT.ring.col, 20));
        const markerRight = markerRect(20).x + markerRect(20).w;
        expect(bubbleCenter(20).x - ringRadius()).toBeGreaterThan(markerRight + LAYOUT.cellW);
        // Neighbouring rows: bubbles must not touch.
        expect(bubbleCenter(21).y - bubbleCenter(20).y).toBeGreaterThan(2 * ringRadius() + 5);
    });
    test("right-column bubbles sit in their own column, right of the divider and the left column's text", () => {
        const C = LAYOUT.columns;
        expect(bubbleCenter(20, 1)).toEqual(cellCenter(C.right.ringCol, 20));
        expect(C.leftLastCol).toBeLessThan(C.dividerCol);
        expect(C.dividerCol).toBeLessThan(C.right.promptCol);
        expect(C.right.promptCol).toBeLessThan(C.right.ringCol);
        // Far enough apart that the bubble search window (±0.35 of a cell) can't reach the other column.
        expect(bubbleCenter(20, 1).x - bubbleCenter(20, 0).x).toBeGreaterThan(10 * LAYOUT.cellW);
    });
});

describe("geometry", () => {
    const H: Mat3 = [1.2, 0.1, 30, -0.05, 1.1, 12, 0.0002, -0.0001, 1];
    const pts = [
        { x: 0, y: 0 },
        { x: 850, y: 0 },
        { x: 850, y: 1100 },
        { x: 0, y: 1100 },
        { x: 400, y: 500 },
        { x: 100, y: 900 },
    ];
    test("fits an exact homography", () => {
        const fit = fitHomography(pts, pts.map((p) => apply(H, p)));
        for (const p of pts) {
            const a = apply(fit, p);
            const b = apply(H, p);
            expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
        }
        const q = apply(invert(H), apply(H, { x: 123, y: 456 }));
        expect(q.x).toBeCloseTo(123, 6);
        expect(q.y).toBeCloseTo(456, 6);
    });
    test("robust fit drops an outlier", () => {
        const dst = pts.map((p) => apply(H, p));
        const src = [...pts, { x: 600, y: 300 }];
        dst.push({ x: 0, y: 0 });
        const { H: fit, inliers } = fitHomographyRobust(src, dst, 1);
        expect(inliers.at(-1)).toBe(false);
        expect(apply(fit, { x: 600, y: 300 }).x).toBeCloseTo(apply(H, { x: 600, y: 300 }).x, 4);
    });
    test("fits an affine map", () => {
        const A: Mat3 = [0.9, -0.2, 5, 0.2, 0.9, -7, 0, 0, 1];
        const fit = fitAffine(pts, pts.map((p) => apply(A, p)));
        fit.forEach((v, i) => expect(v).toBeCloseTo(A[i]!, 9));
    });
});

describe("key", () => {
    test("parses sets, ignoring case and whitespace", () => {
        expect(parseKey(" a , Ab,d ,E", [5, 5, 5, 5])).toEqual({ key: [[0], [0, 1], [3], [4]] });
        expect(parseKey("BA,cc", [4, 4])).toEqual({ key: [[0, 1], [2]] });
    });
    test("rejects wrong counts, empty entries, bad and out-of-range letters", () => {
        expect(parseKey("A,B", [4, 4, 4])).toHaveProperty("error", expect.stringMatching(/2 entries.*3 questions/));
        expect(parseKey("A,,B", [4, 4, 4])).toHaveProperty("error", expect.stringMatching(/question 2 has no answer/));
        expect(parseKey("A,1", [4, 4])).toHaveProperty("error", expect.stringMatching(/not a choice letter/));
        expect(parseKey("A,E", [4, 4])).toHaveProperty("error", expect.stringMatching(/question 2.*out of range/));
    });
});

describe("grade", () => {
    test("exact set match only; percent to one decimal", () => {
        const key = choiceKey([[0], [0, 1], [3]]);
        expect(scoreAnswers([[0], [0, 1], [3]], key)).toEqual({ score: 3, total: 3, percent: "100.0" });
        expect(scoreAnswers([[0], [0], []], key)).toEqual({ score: 1, total: 3, percent: "33.3" });
        expect(scoreAnswers([[0], [1, 0], [3, 2]], key)).toEqual({ score: 2, total: 3, percent: "66.7" });
    });
});

describe("csv", () => {
    test("quotes per RFC 4180", () => {
        expect(csvRow(["Jane Doe", 18, 20, "90.0"])).toBe("Jane Doe,18,20,90.0\r\n");
        expect(csvRow(['Dwayne "The Rock" Johnson', "a,b"])).toBe('"Dwayne ""The Rock"" Johnson","a,b"\r\n');
    });
});

describe("zip", () => {
    test("keeps stored entry order and skips non-images", () => {
        const enc = (s: string) => new TextEncoder().encode(s);
        const zip = zipSync({
            "b/2.jpg": enc("2"),
            "a/10.PNG": enc("10"),
            "__MACOSX/a/._10.PNG": enc("x"),
            ".DS_Store": enc("x"),
            "a/.hidden.jpg": enc("x"),
            "notes.txt": enc("x"),
            "dir/": new Uint8Array(),
            "1.jpeg": enc("1"),
        });
        expect(readZipImages(zip).map((f) => f.name)).toEqual(["b/2.jpg", "a/10.PNG", "1.jpeg"]);
        expect(isPageImage("x/__MACOSX/y.jpg")).toBe(false);
    });
    test("bad zips throw ZipError", () => {
        expect(() => readZipImages(new Uint8Array([1, 2, 3, 4]))).toThrow(ZipError);
    });
});

describe("grouping", () => {
    let n = 0;
    const page = (pageNumber: number, totalPages = 2, firstQuestionIndex = (pageNumber - 1) * 5, questionsOnPage = 5): GroupablePage => ({
        file: `p${++n}.jpg`,
        reasons: [],
        payload: { version: 4, totalPages, pageNumber, totalQuestions: 10, questionsOnPage, firstQuestionIndex, choiceRows: [], columns: [] },
    });
    test("splits on page 1 and validates", () => {
        const groups = groupPages([page(1), page(2), page(1), page(2)]);
        expect(groups.map((g) => g.reasons)).toEqual([[], []]);
    });
    test("orphans before the first page 1", () => {
        const groups = groupPages([page(2), page(2), page(1), page(2)]);
        expect(groups[0]!.orphan).toBe(true);
        expect(groups[0]!.pages).toHaveLength(2);
        expect(groups[1]!.reasons).toEqual([]);
    });
    test("missing, duplicate and out-of-order pages", () => {
        expect(groupPages([page(1), page(1), page(2)])[0]!.reasons[0]).toMatch(/missing page\(s\) 2/);
        expect(groupPages([page(1), page(2), page(2)])[0]!.reasons[0]).toMatch(/duplicate page\(s\) 2/);
        const a = page(1, 3);
        const b = page(3, 3);
        const c = page(2, 3);
        expect(groupPages([a, b, c])[0]!.reasons[0]).toMatch(/page sequence is 1,3,2/);
    });
    test("question ranges must tile the test", () => {
        expect(groupPages([page(1, 2, 0, 5), page(2, 2, 6, 4)])[0]!.reasons[0]).toMatch(/starts at question 7/);
        expect(groupPages([page(1, 2, 0, 5), page(2, 2, 5, 4)])[0]!.reasons[0]).toMatch(/cover 9 of 10/);
    });
    test("disagreeing totals", () => {
        const p2 = page(2);
        p2.payload!.totalPages = 3;
        expect(groupPages([page(1), p2])[0]!.reasons.join()).toMatch(/disagree/);
    });
    test("an unreadable page joins and fails the current submission", () => {
        const bad: GroupablePage = { file: "bad.jpg", reasons: ["QR code not found"] };
        const groups = groupPages([page(1), bad, page(1), page(2)]);
        expect(groups).toHaveLength(2);
        expect(groups[0]!.reasons.join("|")).toMatch(/bad.jpg: QR code not found/);
        expect(groups[1]!.reasons).toEqual([]);
    });
});

describe("fill baseline", () => {
    test("lower quartile (minimum for few rings), capped", () => {
        expect(blankBaseline([0.1, 0.9, 0.1])).toBe(0.1);
        expect(blankBaseline([0.9, 0.95])).toBe(0.2);
        expect(blankBaseline([0.12, 0.1, 0.11, 0.9, 0.95, 0.13, 0.1, 0.12])).toBeCloseTo(0.11, 5);
        expect(blankBaseline([0.9, 0.9, 0.9, 0.9, 0.9, 0.9])).toBe(0.25);
    });
});

describe("ocr", () => {
    test("parses JSON replies, with or without fences", () => {
        expect(parseNameReply('{"name": " Jane   Doe "}')).toBe("Jane Doe");
        expect(parseNameReply('```json\n{"name":"Li Wei"}\n```')).toBe("Li Wei");
        expect(() => parseNameReply("Jane Doe")).toThrow();
    });

    test("retries transient failures, then succeeds", async () => {
        let calls = 0;
        const fakeFetch = (async (_url: string, init: RequestInit) => {
            calls++;
            const body = JSON.parse(String(init.body));
            expect(body.model).toBe("test/model");
            expect(body.messages[0].content[1].image_url.url).toStartWith("data:image/png;base64,");
            if (calls < 3) return new Response("busy", { status: 429 });
            return Response.json({ choices: [{ message: { content: '{"name":"Jane Doe"}' } }] });
        }) as unknown as typeof fetch;
        const r = new OpenRouterReader({ apiKey: "k", visionModel: "test/model", reasoningModel: "test/reasoner", fetch: fakeFetch, backoffMs: 1 });
        expect(await r.readName(new Uint8Array([1, 2]))).toBe("Jane Doe");
        expect(calls).toBe(3);
    });

    test("logs each call's label, time, tokens and cost", async () => {
        const fakeFetch = (async () =>
            Response.json({
                choices: [{ message: { content: '{"name":"Jane Doe"}' } }],
                usage: { prompt_tokens: 4200, completion_tokens: 12, total_tokens: 4212, cost: 0.0123 },
            })) as unknown as typeof fetch;
        const lines: string[] = [];
        const r = new OpenRouterReader({ apiKey: "k", visionModel: "m", reasoningModel: "r", fetch: fakeFetch, log: (l) => lines.push(l) });
        await r.readName(new Uint8Array([1]), "sheet-03.jpg");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^OCR Name for 'sheet-03\.jpg' took \d+\.\ds \(4\.2k input, 12 output, \$0\.01\)$/);
    });

    test("reads handwriting with the vision model and grades with the reasoning model", async () => {
        const models: string[] = [];
        const fakeFetch = (async (_url: string, init: RequestInit) => {
            models.push(JSON.parse(String(init.body)).model);
            return Response.json({ choices: [{ message: { content: '{"name":"Jane","text":"hi","legible":true,"points":1,"feedback":"ok"}' } }] });
        }) as unknown as typeof fetch;
        const r = new OpenRouterReader({ apiKey: "k", visionModel: "vision/m", reasoningModel: "reason/m", fetch: fakeFetch });
        await r.readName(new Uint8Array([1]), "a.png");
        await r.readResponse(new Uint8Array([1]), "a.png", 0, "Q?");
        await r.gradeResponse({ type: "free", prompt: "Q?", answer: "A", points: 2 } as never, "hi", 0, "a.png");
        expect(models).toEqual(["vision/m", "vision/m", "reason/m"]);
    });

    test("logs cached tokens when reported, and routes a run's calls with one session id", async () => {
        const sessions: (string | null)[] = [];
        const fakeFetch = (async (_url: string, init: RequestInit) => {
            sessions.push(new Headers(init.headers).get("x-session-id"));
            return Response.json({
                choices: [{ message: { content: '{"name":"Jane"}' } }],
                usage: { prompt_tokens: 4200, completion_tokens: 12, total_tokens: 4212, prompt_tokens_details: { cached_tokens: 3072 } },
            });
        }) as unknown as typeof fetch;
        const lines: string[] = [];
        const r = new OpenRouterReader({ apiKey: "k", visionModel: "m", reasoningModel: "r", fetch: fakeFetch, log: (l) => lines.push(l), sessionId: "grader-abc" });
        await r.readName(new Uint8Array([1]), "a.jpg");
        await r.readName(new Uint8Array([2]), "b.jpg");
        expect(sessions).toEqual(["grader-abc", "grader-abc"]);
        expect(lines[0]).toMatch(/\(4\.2k input, 3\.1k cached, 12 output\)$/);
    });

    test("reasoning: OCR off when allowed, grading never below low, nothing for non-reasoning models", () => {
        const optional = { id: "v", reasoning: { mandatory: false } };
        const flash = { id: "g", reasoning: { mandatory: true, supported_efforts: ["max", "high", "low"] } };
        const minimalOnly = { id: "m", reasoning: { mandatory: true, supported_efforts: ["minimal", "high"] } };
        const onlyMinimal = { id: "n", reasoning: { mandatory: true, supported_efforts: ["minimal"] } };
        expect(reasoningFor(optional, "ocr")).toEqual({ enabled: false });
        expect(reasoningFor(optional, "grade")).toEqual({ effort: "low" });
        expect(reasoningFor(flash, "ocr")).toEqual({ effort: "low" });
        expect(reasoningFor(flash, "grade")).toEqual({ effort: "low" });
        // Mandatory with "minimal" available: OCR takes it, grading stays at or above low.
        expect(reasoningFor(minimalOnly, "ocr")).toEqual({ effort: "minimal" });
        expect(reasoningFor(minimalOnly, "grade")).toEqual({ effort: "high" });
        expect(reasoningFor(onlyMinimal, "grade")).toEqual({ effort: "minimal" });
        expect(reasoningFor({ id: "plain" }, "ocr")).toBeUndefined();
        expect(reasoningFor(undefined, "grade")).toBeUndefined();
        expect(describeReasoning({ enabled: false })).toBe("off");
        expect(describeReasoning({ effort: "low" })).toBe("effort low");
    });

    test("sends the reasoning setting for each kind of call and logs reasoning tokens", async () => {
        const bodies: { model: string; reasoning?: unknown }[] = [];
        const fakeFetch = (async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(String(init.body)));
            return Response.json({
                choices: [{ message: { content: '{"name":"Jane","text":"hi","legible":true,"points":1,"feedback":"ok"}' } }],
                usage: { prompt_tokens: 367, completion_tokens: 4900, total_tokens: 5267, completion_tokens_details: { reasoning_tokens: 4800 } },
            });
        }) as unknown as typeof fetch;
        const lines: string[] = [];
        const r = new OpenRouterReader({
            apiKey: "k",
            visionModel: "vision/m",
            reasoningModel: "reason/m",
            fetch: fakeFetch,
            log: (l) => lines.push(l),
            reasoning: { vision: { enabled: false }, grading: { effort: "low" } },
        });
        await r.readName(new Uint8Array([1]), "a.jpg");
        await r.gradeResponse({ type: "free", prompt: "Q?", answer: "A", points: 2 } as never, "hi", 0, "a.jpg");
        expect(bodies.map((b) => [b.model, b.reasoning])).toEqual([
            ["vision/m", { enabled: false }],
            ["reason/m", { effort: "low" }],
        ]);
        expect(lines[0]).toMatch(/\(367 input, 4\.9k output, 4\.8k reasoning\)$/);
    });

    test("summarizes each task's time and cost, and all of them", async () => {
        const stats = new CallStats();
        expect(stats.summary()).toEqual([]);
        // start/end in ms: name 1.0s and 3.0s; grading 2.0s; the run spans 0 to 6s.
        stats.record("Name OCR", 0, 1000, 0.0001);
        stats.record("Name OCR", 1000, 4000, 0.0003);
        stats.record("FRQ Grading", 4000, 6000, 0.02);
        stats.fail();
        expect(stats.count).toBe(3);
        expect(stats.summary()).toEqual([
            "Name OCR (2 requests)",
            "  time  min 1.0s · mean 2.0s · max 3.0s · total 4.0s",
            "  cost  min $0.0001 · mean $0.0002 · max $0.0003 · total $0.0004",
            "FRQ Grading (1 request)",
            "  time  min 2.0s · mean 2.0s · max 2.0s · total 2.0s",
            "  cost  min $0.02 · mean $0.02 · max $0.02 · total $0.02",
            "All requests (3, 1 failed)",
            "  time  total 6.0s of request time · 6.0s elapsed from the first request to the last",
            "  cost  total $0.02",
        ]);
    });

    test("the reader records each request under its task", async () => {
        const fakeFetch = (async () =>
            Response.json({ choices: [{ message: { content: '{"name":"J","text":"t","legible":true,"points":1,"feedback":"f"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.001 } })) as unknown as typeof fetch;
        const stats = new CallStats();
        const r = new OpenRouterReader({ apiKey: "k", visionModel: "v", reasoningModel: "r", fetch: fakeFetch, stats });
        await r.readName(new Uint8Array([1]), "a.jpg");
        await r.readResponse(new Uint8Array([1]), "a.jpg", 0, "Q?");
        await r.gradeResponse({ type: "free", prompt: "Q?", answer: "A", points: 1 } as never, "t", 0, "a.jpg");
        const lines = stats.summary();
        expect(lines.filter((l) => /^(Name OCR|FRQ OCR|FRQ Grading) \(1 request\)$/.test(l))).toHaveLength(3);
        expect(lines.at(-1)).toBe("  cost  total $0.0030");
    });

    test("fetchModelInfo finds the models and returns nothing when the list can't be read", async () => {
        const list = (async () => Response.json({ data: [{ id: "a", reasoning: { mandatory: true } }, { id: "other" }] })) as unknown as typeof fetch;
        expect([...(await fetchModelInfo(["a", "b"], list)).keys()]).toEqual(["a"]);
        const down = (async () => {
            throw new Error("offline");
        }) as unknown as typeof fetch;
        expect((await fetchModelInfo(["a"], down)).size).toBe(0);
        expect((await fetchModelInfo(["a"], (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch)).size).toBe(0);
    });

    test("every student's grading prompt for a question shares its prefix up to the answer", () => {
        const key = { type: "free" as const, prompt: "Why?", answer: "Because.", rubric: "1 pt: says because", points: 2 };
        const a = gradingPrompt(key, "first student's answer");
        const b = gradingPrompt(key, "a completely different answer");
        const prefix = (p: string) => p.slice(0, p.indexOf("<<<"));
        expect(prefix(a)).toBe(prefix(b));
        // The question, model answer, rubric and judging rules all come before the answer.
        for (const part of ["Question: Why?", "Model answer: Because.", "Rubric: 1 pt: says because", "Judge the content only"]) expect(prefix(a)).toContain(part);
    });

    test("does not retry client errors", async () => {
        let calls = 0;
        const fakeFetch = (async () => {
            calls++;
            return new Response("bad key", { status: 401 });
        }) as unknown as typeof fetch;
        const r = new OpenRouterReader({ apiKey: "k", visionModel: "m", reasoningModel: "r", fetch: fakeFetch, backoffMs: 1 });
        expect(r.readName(new Uint8Array())).rejects.toThrow(/401/);
        await Bun.sleep(5);
        expect(calls).toBe(1);
    });

    test("limitConcurrency never exceeds the limit", async () => {
        let active = 0;
        let peak = 0;
        const run = limitConcurrency(3, async (ms: number) => {
            peak = Math.max(peak, ++active);
            await Bun.sleep(ms);
            active--;
        });
        await Promise.all(Array.from({ length: 20 }, (_, i) => run(i % 4)));
        expect(peak).toBe(3);
    });
});
