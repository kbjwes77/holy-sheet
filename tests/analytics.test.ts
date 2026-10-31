// First-party analytics: the visitor cookie and page views, opting out, linking visits to an account at sign-up,
// the admin stats and journeys, and what an account deletion leaves behind.
import { afterAll, describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referrerDomain } from "../server/analytics.ts";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";

const db = openDb(":memory:");
const app = createApp({
    db,
    root: process.cwd(),
    signUpsPerHour: 1000,
    adminEmails: ["admin@example.com"],
    grader: { command: [process.execPath, join(import.meta.dir, "helpers", "stub-cli.ts")] },
});
const server = Bun.serve({ port: 0, routes: app.routes });
const base = server.url.origin;
afterAll(() => {
    server.stop(true);
    app.shutdown();
});

/** A browser: keeps its cookies. */
class Browser {
    cookies = new Map<string, string>();
    constructor(readonly headers: Record<string, string> = {}) {}
    async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
        const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
        const res = await fetch(base + path, {
            method,
            headers: { ...this.headers, ...extra, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        for (const c of res.headers.getSetCookie()) {
            const [pair] = c.split(";");
            const i = pair!.indexOf("=");
            this.cookies.set(pair!.slice(0, i), pair!.slice(i + 1));
        }
        const text = await res.text();
        let data: any = text;
        try {
            data = JSON.parse(text);
        } catch {}
        return { status: res.status, data };
    }
    view(path: string, referrer = "", utm: Record<string, string> = {}) {
        return this.call("POST", "/api/t", { path, referrer, utm });
    }
    signUp(email: string) {
        return this.call("POST", "/api/auth/register", { email, displayName: "Teacher", password: "correct horse" });
    }
}

const visitorsCount = () => (db.query("SELECT COUNT(*) AS n FROM visitors").get() as { n: number }).n;
const userId = (email: string) => (db.query("SELECT id FROM users WHERE email = ?").get(email) as { id: number }).id;

describe("analytics", () => {
    test("referrer domains: external sites only, without www.", () => {
        expect(referrerDomain("https://www.google.com/search?q=bubble+sheet", "gradelake.com")).toBe("google.com");
        expect(referrerDomain("https://gradelake.com/pricing", "gradelake.com")).toBeNull();
        expect(referrerDomain("https://www.gradelake.com/", "gradelake.com")).toBeNull();
        expect(referrerDomain("android-app://com.slack", "gradelake.com")).toBeNull();
        expect(referrerDomain("not a url", "gradelake.com")).toBeNull();
        expect(referrerDomain("", "gradelake.com")).toBeNull();
    });

    test("a page view sets the visitor cookie once and keeps the first referrer, landing page and UTM tags", async () => {
        const b = new Browser();
        expect((await b.view("/free-bubble-sheet-generator", "https://www.reddit.com/r/Teachers/", { source: "reddit", medium: "social", campaign: "launch" })).status).toBe(204);
        const id = b.cookies.get("gl_vid")!;
        expect(id).toMatch(/^[\w-]{22}$/);
        await b.view("/pricing", `${base}/free-bubble-sheet-generator`);
        expect(b.cookies.get("gl_vid")).toBe(id);
        const v = db.query("SELECT * FROM visitors WHERE id = ?").get(id) as Record<string, unknown>;
        expect(v).toMatchObject({ referrer: "reddit.com", landing: "/free-bubble-sheet-generator", utm_source: "reddit", utm_medium: "social", utm_campaign: "launch", user_id: null });
        const views = db.query("SELECT path, referrer FROM analytics_events WHERE visitor_id = ? ORDER BY id").all(id);
        expect(views).toEqual([
            { path: "/free-bubble-sheet-generator", referrer: "reddit.com" },
            { path: "/pricing", referrer: null },
        ]);
    });

    test("nothing is recorded for Global Privacy Control, Do Not Track, bots or other sites", async () => {
        const before = visitorsCount();
        for (const headers of [{ "sec-gpc": "1" }, { dnt: "1" }, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }] as Record<string, string>[]) {
            const b = new Browser(headers);
            expect((await b.view("/")).status).toBe(204);
            expect(b.cookies.has("gl_vid")).toBe(false);
        }
        expect((await new Browser().call("POST", "/api/t", { path: "/" }, { origin: "https://evil.example" })).status).toBe(403);
        expect((await new Browser().view("/api/me")).status).toBe(400);
        expect((await new Browser().view("https://elsewhere.example/")).status).toBe(400);
        expect(visitorsCount()).toBe(before);
    });

    test("signing up links the visitor and its earlier views to the account; admins' visits aren't counted", async () => {
        const b = new Browser();
        await b.view("/", "https://news.ycombinator.com/item?id=1");
        await b.view("/pricing");
        await b.view("/register");
        expect((await b.signUp("journey@example.com")).status).toBe(201);
        await b.view("/dashboard");
        const id = userId("journey@example.com");
        expect((db.query("SELECT user_id FROM visitors WHERE id = ?").get(b.cookies.get("gl_vid")!) as { user_id: number }).user_id).toBe(id);
        expect((db.query("SELECT visitor_id FROM analytics_events WHERE kind = 'signup' AND user_id = ?").get(id) as { visitor_id: string }).visitor_id).toBe(b.cookies.get("gl_vid")!);

        const admin = new Browser();
        await admin.signUp("admin@example.com");
        const views = (db.query("SELECT COUNT(*) AS n FROM analytics_events WHERE kind = 'pageview'").get() as { n: number }).n;
        await admin.view("/dashboard");
        expect((db.query("SELECT COUNT(*) AS n FROM analytics_events WHERE kind = 'pageview'").get() as { n: number }).n).toBe(views);

        const { data } = await admin.call("GET", `/api/admin/journey/${id}`);
        expect(data.events.map((e: { kind: string; path: string | null }) => e.path ?? e.kind)).toEqual(["/", "/pricing", "/register", "signup", "/dashboard"]);
    });

    test("stats are for admins only and count sign-ups, materials, grading and visitors per day", async () => {
        const teacher = new Browser();
        await teacher.view("/", "https://www.google.com/");
        await teacher.signUp("stats@example.com");
        expect((await teacher.call("GET", "/api/admin/stats")).status).toBe(403);
        expect((await new Browser().call("GET", "/api/admin/stats")).status).toBe(401);
        const content = JSON.stringify({ test: "Quiz", questions: [{ prompt: "2+2?", choices: ["3", "4"], answer: "B" }] });
        expect((await teacher.call("POST", "/api/materials", { name: "Quiz", type: "Quiz", content })).status).toBe(201);

        // A run that called the models counts its pages as graded.
        const id = userId("stats@example.com");
        db.query("UPDATE users SET plan = 'pro' WHERE id = ?").run(id);
        const zip = zipSync({ "p1.jpg": new Uint8Array([1]), "p2.jpg": new Uint8Array([2]) });
        const cookie = [...teacher.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
        const res = await fetch(`${base}/api/grader/jobs?name=requests.zip`, { method: "POST", headers: { cookie, "content-type": "application/zip" }, body: zip });
        expect(res.status).toBe(201);
        for (let i = 0; i < 100 && !db.query("SELECT 1 FROM analytics_events WHERE kind = 'grade' AND user_id = ?").get(id); i++) await Bun.sleep(50);

        const admin = new Browser();
        await admin.call("POST", "/api/auth/login", { email: "admin@example.com", password: "correct horse" });
        const { status, data } = await admin.call("GET", "/api/admin/stats?days=7");
        expect(status).toBe(200);
        expect(data.series).toHaveLength(7);
        const today = data.series.at(-1);
        expect(today).toMatchObject({ materials: 1, gradeRuns: 1, pages: 2 });
        expect(today.signups).toBe(data.totals.accounts);
        expect(today.accounts).toBe(data.totals.accounts);
        expect(today.visitors).toBeGreaterThan(0);
        expect(data.referrers).toContainEqual({ name: "google.com", visitors: 1, signups: 1 });
        expect(data.funnel).toMatchObject({ material: 1, graded: 1, pro: 1 });
        expect(data.signups.find((s: { email: string }) => s.email === "stats@example.com")).toMatchObject({ referrer: "google.com", landing: "/", viewsBefore: 1 });
    });

    test("deleting an account deletes its visitors but keeps anonymous counts", async () => {
        const b = new Browser();
        await b.view("/", "https://bing.com/");
        await b.signUp("gone@example.com");
        const id = userId("gone@example.com");
        const vid = b.cookies.get("gl_vid")!;
        const pageviews = (db.query("SELECT COUNT(*) AS n FROM analytics_events WHERE kind = 'pageview'").get() as { n: number }).n;
        expect((await b.call("POST", "/api/account/delete", { password: "correct horse" })).status).toBe(200);
        expect(db.query("SELECT 1 FROM visitors WHERE id = ?").get(vid)).toBeNull();
        expect(db.query("SELECT 1 FROM analytics_events WHERE user_id = ? OR visitor_id = ?").get(id, vid)).toBeNull();
        expect((db.query("SELECT COUNT(*) AS n FROM analytics_events WHERE kind = 'pageview'").get() as { n: number }).n).toBe(pageviews);
        expect(db.query("SELECT 1 FROM analytics_events WHERE kind = 'account_deleted'").get()).not.toBeNull();

        const admin = new Browser();
        await admin.call("POST", "/api/auth/login", { email: "admin@example.com", password: "correct horse" });
        const { data } = await admin.call("GET", "/api/admin/stats?days=7");
        expect(data.series.at(-1).accounts).toBe(data.totals.accounts);
    });

    test("the migration backfills sign-ups, materials and graded runs from existing rows", () => {
        const dir = mkdtempSync(join(tmpdir(), "gl-analytics-"));
        const path = join(dir, "app.db");
        try {
            // A database as it was before migration 8, with a user, a material and a graded run.
            const old = openDb(path);
            old.run("DROP TRIGGER analytics_signup; DROP TRIGGER analytics_account_deleted; DROP TRIGGER analytics_material; DROP TABLE analytics_events; DROP TABLE visitors; PRAGMA user_version = 7");
            old.query("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (1, 'x@example.com', 'X', 'h', 1000)").run();
            old.query("INSERT INTO study_materials (owner_id, type, name, content, status, created_at, updated_at) VALUES (1, 'Quiz', 'Q', '{}', 'draft', 2000, 2000)").run();
            old.query("INSERT INTO grade_runs (id, owner_id, name, upload_name, status, created_at) VALUES (5, 1, 'Run', 'a.zip', 'graded', 3000)").run();
            old.query("INSERT INTO usage_events (user_id, kind, quantity, metadata, created_at) VALUES (1, 'grade_pages', 4, '{\"runId\":5}', 3000)").run();
            old.close();

            const db2 = openDb(path);
            expect(db2.query("SELECT kind, quantity, created_at FROM analytics_events ORDER BY created_at").all()).toEqual([
                { kind: "signup", quantity: 1, created_at: 1000 },
                { kind: "material", quantity: 1, created_at: 2000 },
                { kind: "grade", quantity: 4, created_at: 3000 },
            ]);
            db2.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
