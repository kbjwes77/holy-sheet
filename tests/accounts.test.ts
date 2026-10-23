// Accounts, sessions, the material library and plan-gated grading, against a real server on an in-memory database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../server/app.ts";
import { now, openDb } from "../server/db.ts";

const db = openDb(":memory:");
const app = createApp({ db, root: process.cwd(), adminEmails: ["admin@example.com"], signUpsPerHour: 1000 });
const server = Bun.serve({ port: 0, routes: app.routes });
const base = server.url.origin;

afterAll(() => {
    server.stop(true);
    app.shutdown();
});

/** A browser-like client that keeps its session cookie. */
class Client {
    cookie = "";
    async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
        const res = await fetch(base + path, {
            method,
            headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const set = res.headers.get("set-cookie");
        if (set) this.cookie = set.split(";")[0]!;
        const text = await res.text();
        let data: any = text;
        try {
            data = JSON.parse(text);
        } catch {
            // not JSON (a download, or an empty body)
        }
        return { status: res.status, data, res };
    }
    async signUp(email: string, name = "Test User", password = "correct horse") {
        return this.call("POST", "/api/auth/register", { email, displayName: name, password });
    }
}

const TEST_JSON = JSON.stringify({ test: "Quiz 1", questions: [{ prompt: "2+2?", choices: ["3", "4"], answer: "B" }] });
const material = (over: Record<string, unknown> = {}) => ({ name: "Quiz 1", type: "Quiz", tags: ["Math", " algebra "], content: TEST_JSON, ...over });

describe("accounts and sessions", () => {
    test("register signs in with an HttpOnly cookie; login and logout work", async () => {
        const c = new Client();
        const reg = await c.signUp("Alice@Example.com");
        expect(reg.status).toBe(201);
        const cookie = reg.res.headers.get("set-cookie")!;
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Lax");
        const me = await c.call("GET", "/api/me");
        expect(me.data.user).toMatchObject({ email: "alice@example.com", displayName: "Test User", plan: "free", isAdmin: false, canGrade: false });

        expect((await c.call("POST", "/api/auth/logout", {})).status).toBe(200);
        c.cookie = "";
        expect((await c.call("GET", "/api/me")).status).toBe(401);

        expect((await c.call("POST", "/api/auth/login", { email: "alice@example.com", password: "wrong password" })).status).toBe(401);
        expect((await c.call("POST", "/api/auth/login", { email: "alice@example.com", password: "correct horse" })).status).toBe(200);
        expect((await c.call("GET", "/api/me")).status).toBe(200);
    });

    test("passwords are hashed, sessions store only a token hash", async () => {
        const c = new Client();
        await c.signUp("hash@example.com");
        const { password_hash } = db.query("SELECT password_hash FROM users WHERE email = 'hash@example.com'").get() as { password_hash: string };
        expect(password_hash).toStartWith("$argon2");
        const token = c.cookie.split("=")[1]!;
        expect(db.query("SELECT 1 FROM sessions WHERE token_hash = ?").get(token)).toBeNull();
    });

    test("rejects duplicate emails and bad input", async () => {
        const c = new Client();
        expect((await c.signUp("dup@example.com")).status).toBe(201);
        expect((await new Client().signUp("DUP@example.com")).status).toBe(409);
        expect((await new Client().signUp("not-an-email")).status).toBe(400);
        expect((await new Client().signUp("short@example.com", "Name", "short")).status).toBe(400);
        expect((await new Client().signUp("noname@example.com", "  ")).status).toBe(400);
    });

    test("an expired session is rejected and purged; use slides the expiry", async () => {
        const c = new Client();
        await c.signUp("ttl@example.com");
        db.query("UPDATE sessions SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = 'ttl@example.com')").run(now() - 1);
        expect((await c.call("GET", "/api/me")).status).toBe(401);

        const d = new Client();
        await d.signUp("slide@example.com");
        const id = (db.query("SELECT id FROM users WHERE email = 'slide@example.com'").get() as { id: number }).id;
        const soon = now() + 3600;
        db.query("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE user_id = ?").run(soon, now() - 7200, id);
        expect((await d.call("GET", "/api/me")).status).toBe(200);
        const row = db.query("SELECT expires_at FROM sessions WHERE user_id = ?").get(id) as { expires_at: number };
        expect(row.expires_at).toBeGreaterThan(now() + 29 * 24 * 3600);
    });

    test("cross-origin posts are refused", async () => {
        const r = await new Client().call("POST", "/api/auth/login", { email: "a@b.co", password: "x" }, { origin: "https://evil.example" });
        expect(r.status).toBe(403);
    });

    test("repeated failed logins are rate limited", async () => {
        const c = new Client();
        await c.signUp("limit@example.com");
        const codes: number[] = [];
        for (let i = 0; i < 12; i++) codes.push((await c.call("POST", "/api/auth/login", { email: "limit@example.com", password: "nope nope" })).status);
        expect(codes.slice(0, 10).every((s) => s === 401)).toBe(true);
        expect(codes[11]).toBe(429);
    });

    test("only admins edit the MOTD, and everyone sees it", async () => {
        const admin = new Client();
        await admin.signUp("admin@example.com");
        const user = new Client();
        await user.signUp("plain@example.com");
        expect((await user.call("PUT", "/api/motd", { motd: "hi" })).status).toBe(403);
        expect((await admin.call("PUT", "/api/motd", { motd: "Welcome to GradeLake" })).status).toBe(200);
        expect((await user.call("GET", "/api/me")).data.motd).toBe("Welcome to GradeLake");
    });
});

describe("study materials", () => {
    test("requires sign-in", async () => {
        expect((await new Client().call("GET", "/api/materials")).status).toBe(401);
        expect((await new Client().call("GET", "/api/groups")).status).toBe(401);
    });

    test("create validates the test JSON, normalizes tags, and queries by type, name and tag", async () => {
        const c = new Client();
        await c.signUp("author@example.com");
        const bad = await c.call("POST", "/api/materials", material({ content: "{not json" }));
        expect(bad.status).toBe(400);
        expect((await c.call("POST", "/api/materials", material({ type: "Poem" }))).status).toBe(400);

        const made = await c.call("POST", "/api/materials", material());
        expect(made.status).toBe(201);
        expect(made.data).toMatchObject({ type: "Quiz", name: "Quiz 1", tags: ["algebra", "math"], status: "draft", mine: true });
        await c.call("POST", "/api/materials", material({ name: "Biology Exam", type: "Exam", tags: ["bio"] }));

        const list = (qs: string) => c.call("GET", `/api/materials?${qs}`).then((r) => r.data.materials.map((m: any) => m.name));
        expect(await list("")).toHaveLength(2);
        expect(await list("type=Exam")).toEqual(["Biology Exam"]);
        expect(await list("q=quiz")).toEqual(["Quiz 1"]);
        expect(await list("tag=math")).toEqual(["Quiz 1"]);
        expect(await list("tag=math&tag=bio")).toEqual([]);
        expect(await list("q=%25")).toEqual([]);
        // The list leaves out the (large) content.
        expect((await c.call("GET", "/api/materials")).data.materials[0].content).toBeUndefined();
    });

    test("draft and private are author-only; published is visible, downloadable and copyable by others", async () => {
        const author = new Client();
        await author.signUp("pub@example.com", "Pat");
        const other = new Client();
        await other.signUp("reader@example.com");
        const draft = (await author.call("POST", "/api/materials", material({ name: "Secret" }))).data;
        const pub = (await author.call("POST", "/api/materials", material({ name: "Shared", status: "published", tags: ["shared"] }))).data;

        expect((await other.call("GET", `/api/materials/${draft.id}`)).status).toBe(404);
        expect((await other.call("GET", `/api/materials/${draft.id}/download`)).status).toBe(404);
        expect((await other.call("POST", `/api/materials/${draft.id}/copy`, {})).status).toBe(404);
        await author.call("PATCH", `/api/materials/${draft.id}`, { status: "private" });
        expect((await other.call("GET", `/api/materials/${draft.id}`)).status).toBe(404);

        const community = await other.call("GET", "/api/materials?scope=community&tag=shared");
        expect(community.data.materials.map((m: any) => m.name)).toEqual(["Shared"]);
        expect(community.data.materials[0]).toMatchObject({ author: "Pat", mine: false });
        expect((await other.call("GET", "/api/materials?scope=community")).data.materials.some((m: any) => m.name === "Secret")).toBe(false);

        const dl = await other.call("GET", `/api/materials/${pub.id}/download`);
        expect(dl.status).toBe(200);
        expect(dl.res.headers.get("content-disposition")).toContain("Shared.json");
        expect(dl.data.test).toBe("Quiz 1");

        const copy = await other.call("POST", `/api/materials/${pub.id}/copy`, {});
        expect(copy.status).toBe(201);
        expect(copy.data).toMatchObject({ mine: true, status: "draft", tags: ["shared"] });
        const kinds = db.query("SELECT kind FROM usage_events WHERE user_id = (SELECT id FROM users WHERE email = 'reader@example.com')").all() as { kind: string }[];
        expect(kinds.map((k) => k.kind)).toEqual(expect.arrayContaining(["material_downloaded", "material_copied"]));
    });

    test("only the author edits or deletes", async () => {
        const author = new Client();
        await author.signUp("owner@example.com");
        const other = new Client();
        await other.signUp("meddler@example.com");
        const m = (await author.call("POST", "/api/materials", material({ status: "published" }))).data;
        expect((await other.call("PATCH", `/api/materials/${m.id}`, { name: "Hacked" })).status).toBe(404);
        expect((await other.call("DELETE", `/api/materials/${m.id}`)).status).toBe(404);
        expect((await author.call("PATCH", `/api/materials/${m.id}`, { name: "Renamed", tags: ["x"] })).data).toMatchObject({ name: "Renamed", tags: ["x"] });
        expect((await author.call("DELETE", `/api/materials/${m.id}`)).status).toBe(204);
        expect((await author.call("GET", `/api/materials/${m.id}`)).status).toBe(404);
    });
});

describe("material groups", () => {
    test("nest as a tree, hold materials, reject cycles, and cascade on delete", async () => {
        const c = new Client();
        await c.signUp("groups@example.com");
        const a = (await c.call("POST", "/api/groups", { name: "Unit 4" })).data;
        const b = (await c.call("POST", "/api/groups", { name: "Quizzes", parentId: a.id })).data;
        expect(b.parentId).toBe(a.id);
        const m = (await c.call("POST", "/api/materials", material({ groupId: b.id }))).data;
        expect(m.groupId).toBe(b.id);
        expect((await c.call("GET", `/api/materials?group=${b.id}`)).data.materials).toHaveLength(1);
        expect((await c.call("GET", "/api/materials?group=root")).data.materials).toHaveLength(0);

        expect((await c.call("PATCH", `/api/groups/${a.id}`, { parentId: b.id })).status).toBe(400);
        expect((await c.call("PATCH", `/api/groups/${a.id}`, { parentId: a.id })).status).toBe(400);
        expect((await c.call("PATCH", `/api/groups/${b.id}`, { parentId: null })).data.parentId).toBeNull();
        await c.call("PATCH", `/api/groups/${b.id}`, { parentId: a.id });

        expect((await c.call("DELETE", `/api/groups/${a.id}`)).status).toBe(204);
        expect((await c.call("GET", "/api/groups")).data.groups).toHaveLength(0);
        expect((await c.call("GET", `/api/materials/${m.id}`)).status).toBe(404);
    });

    test("can't use another user's group", async () => {
        const one = new Client();
        await one.signUp("g1@example.com");
        const two = new Client();
        await two.signUp("g2@example.com");
        const g = (await one.call("POST", "/api/groups", { name: "Mine" })).data;
        expect((await two.call("POST", "/api/materials", material({ groupId: g.id }))).status).toBe(404);
        expect((await two.call("PATCH", `/api/groups/${g.id}`, { name: "x" })).status).toBe(404);
        expect((await two.call("DELETE", `/api/groups/${g.id}`)).status).toBe(404);
        expect((await two.call("GET", "/api/groups")).data.groups).toHaveLength(0);
    });
});

describe("grading is gated by plan", () => {
    test("free users can't start a job; pro users can, and usage is recorded", async () => {
        const c = new Client();
        await c.signUp("grader@example.com");
        expect((await c.call("GET", "/api/grader/info")).status).toBe(200);
        const zipHeaders = { "content-type": "application/zip" };
        const attempt = () => fetch(`${base}/api/grader/jobs?name=x.zip`, { method: "POST", headers: { ...zipHeaders, cookie: c.cookie }, body: new Uint8Array([1, 2, 3]) });
        expect((await attempt()).status).toBe(402);
        expect((await new Client().call("GET", "/api/grader/info")).status).toBe(401);

        db.query("UPDATE users SET plan = 'pro' WHERE email = 'grader@example.com'").run();
        expect((await c.call("GET", "/api/me")).data.user.canGrade).toBe(true);
        const res = await attempt();
        expect(res.status).toBe(201);
        const { id } = (await res.json()) as { id: string };
        expect((await c.call("GET", "/api/me")).data.user.usage.gradeRunsThisMonth).toBe(1);

        // Another user can't see or cancel this job.
        const other = new Client();
        await other.signUp("snoop@example.com");
        expect((await other.call("POST", `/api/grader/jobs/${id}/cancel`, {})).status).toBe(404);
        await c.call("POST", `/api/grader/jobs/${id}/cancel`, {});
    });
});
