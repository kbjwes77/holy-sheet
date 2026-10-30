// Welcome and password-reset emails, with a capturing transport in place of Resend.
import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "../server/app.ts";
import { emailOptionsFromEnv, RESEND_TEST_FROM, type EmailMessage } from "../server/email.ts";
import { now, openDb } from "../server/db.ts";

const sent: EmailMessage[] = [];
const db = openDb(":memory:");
const app = createApp({ db, root: process.cwd(), signUpsPerHour: 1000, email: { publicUrl: "https://gradelake.test", transport: async (m) => void sent.push(m) } });
const server = Bun.serve({ port: 0, routes: app.routes });
const base = server.url.origin;

afterAll(() => {
    server.stop(true);
    app.shutdown();
});

async function post(path: string, body: unknown, cookie = "") {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, data: (await res.json()) as any, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

const lastTo = (to: string) => sent.findLast((m) => m.to === to);
const tokenFrom = (m: EmailMessage) => /#token=([\w-]+)/.exec(m.text)![1]!;
/** Lets fire-and-forget sends land. */
const settle = () => Bun.sleep(10);

describe("email", () => {
    test("sign-up sends a welcome email linking to the configured site", async () => {
        await post("/api/auth/register", { email: "Wendy@Example.com", displayName: "Wendy <b>", password: "correct horse" });
        await settle();
        const m = lastTo("wendy@example.com")!;
        expect(m.subject).toBe("Welcome to Grade Lake");
        expect(m.text).toContain("https://gradelake.test/dashboard");
        expect(m.html).toContain("Wendy &#60;b&#62;");
        expect(m.idempotencyKey).toMatch(/^welcome-\d+$/);
    });

    test("forgot answers the same for unknown emails and sends nothing", async () => {
        const before = sent.length;
        const r = await post("/api/auth/forgot", { email: "nobody@example.com" });
        await settle();
        expect(r).toMatchObject({ status: 200, data: { ok: true } });
        expect(sent.length).toBe(before);
        expect((await post("/api/auth/forgot", { email: "not an email" })).status).toBe(400);
    });

    test("a reset link sets the password once, ends other sessions and signs in", async () => {
        const reg = await post("/api/auth/register", { email: "rita@example.com", displayName: "Rita", password: "old password" });
        await post("/api/auth/forgot", { email: "RITA@example.com" });
        await settle();
        const m = lastTo("rita@example.com")!;
        expect(m.subject).toBe("Reset your Grade Lake password");
        expect(m.text).toContain("https://gradelake.test/reset-password#token=");
        const token = tokenFrom(m);

        expect((await post("/api/auth/reset", { token, password: "short" })).status).toBe(400);
        const ok = await post("/api/auth/reset", { token, password: "new password" });
        expect(ok.status).toBe(200);
        expect(ok.cookie).toStartWith("gl_session=");

        // The old session is gone; the new one works; the link is spent.
        expect((await fetch(base + "/api/me", { headers: { cookie: reg.cookie } })).status).toBe(401);
        expect((await fetch(base + "/api/me", { headers: { cookie: ok.cookie } })).status).toBe(200);
        expect((await post("/api/auth/reset", { token, password: "another password" })).status).toBe(400);
        expect((await post("/api/auth/login", { email: "rita@example.com", password: "old password" })).status).toBe(401);
        expect((await post("/api/auth/login", { email: "rita@example.com", password: "new password" })).status).toBe(200);
    });

    test("only the newest link works, and expired links are refused", async () => {
        await post("/api/auth/register", { email: "eve@example.com", displayName: "Eve", password: "old password" });
        await post("/api/auth/forgot", { email: "eve@example.com" });
        await settle();
        const first = tokenFrom(lastTo("eve@example.com")!);
        await post("/api/auth/forgot", { email: "eve@example.com" });
        await settle();
        const second = tokenFrom(lastTo("eve@example.com")!);
        expect((await post("/api/auth/reset", { token: first, password: "new password" })).status).toBe(400);

        db.query("UPDATE password_resets SET expires_at = ?").run(now() - 1);
        expect((await post("/api/auth/reset", { token: second, password: "new password" })).status).toBe(400);
    });

    test("reset emails are capped per account", async () => {
        await post("/api/auth/register", { email: "flood@example.com", displayName: "F", password: "old password" });
        for (let i = 0; i < 5; i++) await post("/api/auth/forgot", { email: "flood@example.com" });
        await settle();
        expect(sent.filter((m) => m.to === "flood@example.com" && m.subject.startsWith("Reset")).length).toBe(3);
    });

    test("env: in production a Resend key needs EMAIL_FROM and APP_BASE_URL; in development they default", () => {
        expect(emailOptionsFromEnv({})).toEqual({ apiKey: undefined, from: undefined, publicUrl: undefined });
        const prod = { NODE_ENV: "production", RESEND_EMAIL_API_KEY: "re_x" };
        expect(() => emailOptionsFromEnv(prod)).toThrow("EMAIL_FROM");
        expect(() => emailOptionsFromEnv({ ...prod, EMAIL_FROM: "a@b.c" })).toThrow("APP_BASE_URL");
        expect(emailOptionsFromEnv({ RESEND_EMAIL_API_KEY: "re_x" })).toEqual({ apiKey: "re_x", from: RESEND_TEST_FROM, publicUrl: undefined });
    });
});
