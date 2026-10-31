// Grading limits: one unfinished job per user, a cap on jobs working across all users (a job waiting
// on the teacher doesn't count), and a monthly page budget, refunded when a run calls no model.
import { afterAll, describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { join } from "node:path";
import { createApp, type AppOptions } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import { countZipPages } from "../src/zip.ts";

const stubCli = [process.execPath, join(import.meta.dir, "helpers", "stub-cli.ts")];
const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

/** An app on its own in-memory database, its grader running the stub CLI. */
function serve(over: Partial<AppOptions> = {}) {
    const db = over.db ?? openDb(":memory:");
    const app = createApp({ db, root: process.cwd(), signUpsPerHour: 1000, adminEmails: ["admin@example.com"], grader: { command: stubCli }, ...over });
    const server = Bun.serve({ port: 0, routes: app.routes });
    stops.push(() => {
        server.stop(true);
        app.shutdown();
    });
    const base = server.url.origin;

    async function user(email: string) {
        const res = await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, displayName: "T", password: "correct horse" }) });
        expect(res.status).toBe(201);
        const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
        db.query("UPDATE users SET plan = 'pro' WHERE email = ?").run(email);
        const call = (path: string, method = "GET") => fetch(base + path, { method, headers: { cookie } });
        return {
            /** Starts a job on a zip of `pages` page images; `name` steers the stub CLI. */
            grade: (name: string, pages = 1) => {
                const files = Object.fromEntries(Array.from({ length: pages }, (_, i) => [`p${i + 1}.jpg`, new Uint8Array([i])]));
                return fetch(`${base}/api/grader/jobs?name=${encodeURIComponent(name)}`, { method: "POST", headers: { cookie, "content-type": "application/zip" }, body: zipSync(files) });
            },
            cancel: (id: string) => call(`/api/grader/jobs/${id}/cancel`, "POST"),
            jobs: async () => ((await (await call("/api/grader/jobs")).json()) as { jobs: { id: string; runId: number | null; name: string; waiting: boolean }[] }).jobs,
            status: async (runId: number) => ((await (await call(`/api/grade-runs/${runId}`)).json()) as { run: { status: string } }).run.status,
            usage: async () => ((await (await call("/api/me")).json()) as { user: { usage: { pagesThisMonth: number; pageLimit: number | null } } }).user.usage,
            /** Waits until the run has finished and its pages are settled. */
            settled: async (runId: number) => {
                for (let i = 0; i < 100; i++) {
                    const run = ((await (await call(`/api/grade-runs/${runId}`)).json()) as { run: { status: string } }).run;
                    if (run.status !== "running") return;
                    await Bun.sleep(50);
                }
                throw new Error(`run ${runId} didn't finish`);
            },
        };
    }
    return { user };
}

const started = async (res: Response) => {
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; runId: number };
};

describe("grading limits", () => {
    test("pages are counted as the CLI reads them", () => {
        const zip = zipSync({ "a.jpg": new Uint8Array([1]), "b.PNG": new Uint8Array([1]), "notes.txt": new Uint8Array([1]), "__MACOSX/._a.jpg": new Uint8Array([1]), ".hidden.png": new Uint8Array([1]) });
        expect(countZipPages(zip)).toBe(2);
        expect(countZipPages(new Uint8Array([1, 2, 3]))).toBe(0);
    });

    test("one unfinished job per user; another user can still start one", async () => {
        const { user } = serve();
        const a = await user("a@example.com");
        const b = await user("b@example.com");
        const first = await started(await a.grade("hold.zip"));
        const again = await a.grade("hold.zip");
        expect(again.status).toBe(429);
        expect(((await again.json()) as { error: string }).error).toMatch(/already have a grading run in progress/);
        const other = await started(await b.grade("hold.zip"));

        // Once the first run ends, the user can start another.
        await a.cancel(first.id);
        await a.settled(first.runId);
        const next = await started(await a.grade("hold.zip"));
        await a.cancel(next.id);
        await b.cancel(other.id);
    });

    test("the server-wide cap counts working jobs, not ones waiting on the teacher", async () => {
        const { user } = serve({ limits: { jobs: 2 } });
        const [a, b, c] = [await user("a@example.com"), await user("b@example.com"), await user("c@example.com")];
        const ja = await started(await a.grade("hold.zip"));
        const jb = await started(await b.grade("prompt.zip"));
        const busy = await c.grade("hold.zip");
        // b's job may not have reached its prompt yet; once it has, c gets in.
        let jc: { id: string } | null = null;
        if (busy.status === 429) {
            expect(busy.headers.get("retry-after")).toBe("60");
            expect(((await busy.json()) as { error: string }).error).toMatch(/busy/);
            for (let i = 0; i < 100 && !jc; i++) {
                await Bun.sleep(50);
                const res = await c.grade("hold.zip");
                if (res.status === 201) jc = await res.json();
            }
        } else jc = await started(busy);
        expect(jc).not.toBeNull();
        // Two working (a and c) and one waiting (b): a fourth user is turned away.
        const d = await user("d@example.com");
        expect((await d.grade("hold.zip")).status).toBe(429);
        for (const [u, id] of [[a, ja.id], [b, jb.id], [c, jc!.id]] as const) await u.cancel(id);
    });

    test("the monthly page budget: charged at start, refunded when no model was called, admins exempt", async () => {
        const { user } = serve({ pagesPerMonth: 10 });
        const t = await user("teacher@example.com");
        expect(await t.usage()).toMatchObject({ pagesThisMonth: 0, pageLimit: 10 });

        // Models were called: cancelling keeps the pages charged.
        const run = await started(await t.grade("requests-hold.zip", 6));
        expect((await t.usage()).pagesThisMonth).toBe(6);
        await Bun.sleep(200);
        await t.cancel(run.id);
        await t.settled(run.runId);
        expect((await t.usage()).pagesThisMonth).toBe(6);

        const over = await t.grade("x.zip", 5);
        expect(over.status).toBe(429);
        expect(((await over.json()) as { error: string }).error).toMatch(/this upload has 5 pages, but only 4 of your 10 pages this month are left\. Your allowance resets on /);

        // No model was called (e.g. a bad zip or the wrong test): the pages come back.
        const free = await started(await t.grade("x.zip", 4));
        await t.settled(free.runId);
        expect((await t.usage()).pagesThisMonth).toBe(6);

        const full = await started(await t.grade("requests.zip", 4));
        await t.settled(full.runId);
        expect((await t.usage()).pagesThisMonth).toBe(10);
        const none = await t.grade("x.zip", 1);
        expect(((await none.json()) as { error: string }).error).toMatch(/you've graded all 10 of this month's pages/);

        const admin = await user("admin@example.com");
        expect((await admin.usage()).pageLimit).toBeNull();
        const big = await started(await admin.grade("requests.zip", 50));
        await admin.settled(big.runId);
    });

    test("unfinished jobs are listed for their owner, so a page opened later can pick one up", async () => {
        const { user } = serve();
        const a = await user("a@example.com");
        const b = await user("b@example.com");
        const job = await started(await a.grade("prompt.zip"));
        for (let i = 0; i < 100 && !(await a.jobs())[0]?.waiting; i++) await Bun.sleep(20);
        expect(await a.jobs()).toEqual([expect.objectContaining({ id: job.id, runId: job.runId, name: "prompt.zip", waiting: true })]);
        expect(await b.jobs()).toEqual([]);
        await a.cancel(job.id);
        await a.settled(job.runId);
        expect(await a.jobs()).toEqual([]);
    });

    test("a prompt left unanswered cancels the run, frees the user's slot and, with no model called, refunds its pages", async () => {
        const { user } = serve({ grader: { command: stubCli, waitTimeoutMs: 200 } });
        const t = await user("teacher@example.com");
        const job = await started(await t.grade("prompt.zip", 3));
        expect((await t.usage()).pagesThisMonth).toBe(3);
        await t.settled(job.runId);
        expect(await t.status(job.runId)).toBe("cancelled");
        expect((await t.usage()).pagesThisMonth).toBe(0);
        const next = await started(await t.grade("hold.zip"));
        await t.cancel(next.id);
    });

    test("a run cut off by a restart is marked interrupted and its pages refunded", async () => {
        const db = openDb(":memory:");
        const before = serve({ db });
        const t = await before.user("teacher@example.com");
        // Models were called, so only the restart (not the run ending) gives the pages back.
        const job = await started(await t.grade("requests-hold.zip", 5));
        expect((await t.usage()).pagesThisMonth).toBe(5);
        serve({ db });
        expect(await t.status(job.runId)).toBe("interrupted");
        expect((await t.usage()).pagesThisMonth).toBe(0);
        await t.cancel(job.id);
    });
});
