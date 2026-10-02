import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { csvRow } from "../src/csv.ts";
import { apply, fitAffine, fitHomography, fitHomographyRobust, invert, type Mat3 } from "../src/geometry.ts";
import { scoreAnswers } from "../src/grade.ts";
import { groupPages, type GroupablePage } from "../src/grouping.ts";
import { parseKey } from "../src/key.ts";
import { LAYOUT, bubbleCenter, cellCenter, markerRect, ringRadius } from "../src/layout.ts";
import { limitConcurrency, OpenRouterNameReader, parseNameReply } from "../src/ocr.ts";
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
        const key = [[0], [0, 1], [3]];
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
        const r = new OpenRouterNameReader({ apiKey: "k", model: "test/model", fetch: fakeFetch, backoffMs: 1 });
        expect(await r.readName(new Uint8Array([1, 2]))).toBe("Jane Doe");
        expect(calls).toBe(3);
    });

    test("does not retry client errors", async () => {
        let calls = 0;
        const fakeFetch = (async () => {
            calls++;
            return new Response("bad key", { status: 401 });
        }) as unknown as typeof fetch;
        const r = new OpenRouterNameReader({ apiKey: "k", model: "m", fetch: fakeFetch, backoffMs: 1 });
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
