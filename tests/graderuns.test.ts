// Saved grading runs: recorded when a job starts, filled in when the CLI exits, then listed,
// curved, renamed, downloaded and deleted by their owner only.
import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "../server/app.ts";
import { createGradeRuns } from "../server/grade-runs.ts";
import { openDb } from "../server/db.ts";
import { applyCurves, csvRow, parseCsv } from "../src/csv.ts";

const db = openDb(":memory:");
const app = createApp({ db, root: process.cwd(), signUpsPerHour: 1000 });
const server = Bun.serve({ port: 0, routes: app.routes });
const base = server.url.origin;

afterAll(() => {
    server.stop(true);
    app.shutdown();
});

class Client {
    cookie = "";
    id = 0;
    async call(method: string, path: string, body?: unknown) {
        const res = await fetch(base + path, {
            method,
            headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(this.cookie ? { cookie: this.cookie } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const set = res.headers.get("set-cookie");
        if (set) this.cookie = set.split(";")[0]!;
        const text = await res.text();
        let data: any = text;
        try {
            data = JSON.parse(text);
        } catch {
            // a CSV download or an empty body
        }
        return { status: res.status, data, res };
    }
    static async signUp(email: string, plan: "free" | "pro" = "free") {
        const c = new Client();
        const r = await c.call("POST", "/api/auth/register", { email, displayName: "Teacher", password: "correct horse" });
        expect(r.status).toBe(201);
        c.id = (db.query("SELECT id FROM users WHERE email = ?").get(email) as { id: number }).id;
        db.query("UPDATE users SET plan = ? WHERE id = ?").run(plan, c.id);
        return c;
    }
}

const CSV = [
    ["student_name", "score", "total", "percent"],
    ["Ada", "8", "10", "80.0"],
    ["Ben", "5", "10", "50.0"],
]
    .map(csvRow)
    .join("");

describe("applyCurves", () => {
    test("adds points to curved rows and recomputes their percent; no curve leaves the CSV alone", () => {
        expect(applyCurves(CSV, [0, 0])).toBe(CSV);
        expect(parseCsv(applyCurves(CSV, [0, 2])).slice(1)).toEqual([
            ["Ada", "8", "10", "80.0"],
            ["Ben", "7", "10", "70.0"],
        ]);
    });
});

describe("saved grading runs", () => {
    test("a finished run is listed with its stats, and only its owner can see it", async () => {
        const c = await Client.signUp("owner@example.com");
        const runId = app.gradeRuns.start(c.id, { uploadName: "period 3.zip", testTitle: "Unit 4 Quiz" });
        let list = (await c.call("GET", "/api/grade-runs")).data;
        expect(list.total).toBe(1);
        expect(list.runs[0]).toMatchObject({ id: runId, name: "Unit 4 Quiz", uploadName: "period 3.zip", status: "running", students: 0 });

        app.gradeRuns.finish(runId, { exitCode: 2, cancelled: false, csv: CSV, totals: "graded 2, skipped 1 submission(s) from period 3.zip", skipped: [{ orphan: false, files: ["c.jpg"], reasons: ["QR code not found"] }] });
        list = (await c.call("GET", "/api/grade-runs")).data;
        expect(list.runs[0]).toMatchObject({ status: "partial", exitCode: 2, students: 2, average: 65 });
        const run = (await c.call("GET", `/api/grade-runs/${runId}`)).data.run;
        expect(run.csv).toBe(CSV);
        expect(run.curves).toEqual([]);
        expect(run.skipped).toEqual([{ orphan: false, files: ["c.jpg"], reasons: ["QR code not found"] }]);
        expect(run.totals).toMatch(/graded 2/);

        // Finishing twice doesn't overwrite the first outcome.
        app.gradeRuns.finish(runId, { exitCode: 1, cancelled: false, csv: "", skipped: [] });
        expect((await c.call("GET", `/api/grade-runs/${runId}`)).data.run.status).toBe("partial");

        const other = await Client.signUp("snoop@example.com");
        expect((await other.call("GET", "/api/grade-runs")).data.total).toBe(0);
        for (const [method, path, body] of [
            ["GET", `/api/grade-runs/${runId}`],
            ["GET", `/api/grade-runs/${runId}/csv`],
            ["PATCH", `/api/grade-runs/${runId}`, { name: "mine now" }],
            ["DELETE", `/api/grade-runs/${runId}`],
        ] as const) {
            expect((await other.call(method, path, body)).status).toBe(404);
        }
        expect((await new Client().call("GET", "/api/grade-runs")).status).toBe(401);
    });

    test("curves, per-question results and a new name are saved; the download is curved", async () => {
        const c = await Client.signUp("curve@example.com");
        const runId = app.gradeRuns.start(c.id, { uploadName: "sheets.zip" });
        expect((await c.call("PATCH", `/api/grade-runs/${runId}`, { curves: [] })).status).toBe(409);
        app.gradeRuns.finish(runId, { exitCode: 0, cancelled: false, csv: CSV, skipped: [] });

        expect((await c.call("PATCH", `/api/grade-runs/${runId}`, { curves: [1] })).status).toBe(400);
        expect((await c.call("PATCH", `/api/grade-runs/${runId}`, { curves: [1, 1.5] })).status).toBe(400);
        expect((await c.call("PATCH", `/api/grade-runs/${runId}`, { curves: [0, 5000] })).status).toBe(400);
        expect((await c.call("PATCH", `/api/grade-runs/${runId}`, { questions: [[1, 3, 2]] })).status).toBe(400);
        expect((await c.call("PATCH", `/api/grade-runs/${runId}`, { name: " " })).status).toBe(400);
        expect((await c.call("PATCH", `/api/grade-runs/${runId}`, {})).status).toBe(400);

        const patched = await c.call("PATCH", `/api/grade-runs/${runId}`, { name: "Period 3", curves: [0, 2], questions: [[1, 2, 2], [2, 0, 2]] });
        expect(patched.status).toBe(200);
        expect(patched.data.run).toMatchObject({ name: "Period 3", average: 75 });
        const run = (await c.call("GET", `/api/grade-runs/${runId}`)).data.run;
        expect(run.name).toBe("Period 3");
        expect(run.curves).toEqual([0, 2]);
        expect(run.questions).toEqual([[1, 2, 2], [2, 0, 2]]);
        // The CLI's own CSV is kept; the curve is applied on download.
        expect(run.csv).toBe(CSV);

        const dl = await c.call("GET", `/api/grade-runs/${runId}/csv`);
        expect(dl.res.headers.get("content-disposition")).toBe('attachment; filename="Period 3-grades.csv"');
        expect(parseCsv(dl.data)[2]).toEqual(["Ben", "7", "10", "70.0"]);

        // Clearing the curve restores the average.
        expect((await c.call("PATCH", `/api/grade-runs/${runId}`, { curves: [0, 0] })).data.run.average).toBe(65);
        expect((await c.call("GET", `/api/grade-runs/${runId}`)).data.run.curves).toEqual([]);

        expect((await c.call("DELETE", `/api/grade-runs/${runId}`, undefined)).status).toBe(204);
        expect((await c.call("GET", `/api/grade-runs/${runId}`)).status).toBe(404);
    });

    test("a run still marked running when the server starts is interrupted, and can't be deleted while running", async () => {
        const c = await Client.signUp("restart@example.com");
        const runId = app.gradeRuns.start(c.id, { uploadName: "sheets.zip" });
        expect((await c.call("DELETE", `/api/grade-runs/${runId}`)).status).toBe(409);
        createGradeRuns(db, app.auth);
        expect((await c.call("GET", `/api/grade-runs/${runId}`)).data.run.status).toBe("interrupted");
        // The old process's exit arrives late and changes nothing.
        app.gradeRuns.finish(runId, { exitCode: 0, cancelled: false, csv: CSV, skipped: [] });
        expect((await c.call("GET", `/api/grade-runs/${runId}`)).data.run).toMatchObject({ status: "interrupted", csv: "" });
    });

    test("a material is linked only if the user can see it; deleting the material keeps the run", async () => {
        const owner = await Client.signUp("author@example.com");
        const content = JSON.stringify({ test: "Quiz 1", questions: [{ prompt: "2+2?", choices: ["3", "4"], answer: "B" }] });
        const m = (await owner.call("POST", "/api/materials", { name: "Quiz 1", type: "Quiz", content, status: "private" })).data;
        const stranger = await Client.signUp("stranger@example.com");
        const theirs = app.gradeRuns.start(stranger.id, { uploadName: "a.zip", materialId: m.id });
        expect((await stranger.call("GET", `/api/grade-runs/${theirs}`)).data.run.materialId).toBeNull();
        const mine = app.gradeRuns.start(owner.id, { uploadName: "a.zip", materialId: m.id });
        expect((await owner.call("GET", `/api/grade-runs/${mine}`)).data.run.materialId).toBe(m.id);
        await owner.call("DELETE", `/api/materials/${m.id}`);
        expect((await owner.call("GET", `/api/grade-runs/${mine}`)).data.run).toMatchObject({ id: mine, materialId: null });
    });

    test(
        "a real job records its run when it starts and saves the outcome when the CLI exits",
        async () => {
            const c = await Client.signUp("pro@example.com", "pro");
            const form = new FormData();
            form.append("zip", new Blob([new Uint8Array([1, 2, 3])], { type: "application/zip" }), "broken.zip");
            form.append("test", new Blob([JSON.stringify({ test: "Broken Quiz", questions: [] })], { type: "application/json" }), "t.json");
            const res = await fetch(`${base}/api/grader/jobs?name=broken.zip`, { method: "POST", headers: { cookie: c.cookie }, body: form });
            expect(res.status).toBe(201);
            const { runId } = (await res.json()) as { id: string; runId: number };
            expect(typeof runId).toBe("number");

            let run: any;
            for (let i = 0; i < 300; i++) {
                run = (await c.call("GET", `/api/grade-runs/${runId}`)).data.run;
                if (run.status !== "running") break;
                await Bun.sleep(100);
            }
            expect(run).toMatchObject({ name: "Broken Quiz", uploadName: "broken.zip", status: "failed" });
            expect(run.exitCode).toBe(1);
            expect(run.finishedAt).toBeGreaterThan(0);
        },
        60_000,
    );
});
