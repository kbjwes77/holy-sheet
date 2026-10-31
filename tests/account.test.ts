// Account settings: display name, password, email change by confirmed link, and self-serve deletion (which ends
// Stripe billing first). Emails are captured instead of sent, and Stripe's network calls are stubbed.
import { afterAll, describe, expect, test } from "bun:test";
import Stripe from "stripe";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import type { EmailMessage } from "../server/email.ts";

const sent: EmailMessage[] = [];
const deleted: string[] = [];
let failStripe = false;
const stripe = new Stripe("sk_test_dummy");
(stripe as any).customers = {
    del: async (id: string) => {
        if (failStripe) throw Object.assign(new Error("Stripe is down"), { code: "api_error" });
        deleted.push(id);
        return { id, deleted: true };
    },
};

const db = openDb(":memory:");
const app = createApp({
    db,
    root: process.cwd(),
    signUpsPerHour: 1000,
    email: { publicUrl: "https://gradelake.test", transport: async (m) => void sent.push(m) },
    billing: { stripe, webhookSecret: "whsec_test", priceMonthly: "price_m", priceYearly: "price_y", mode: "sandbox" },
});
const server = Bun.serve({ port: 0, routes: app.routes });
const base = server.url.origin;
afterAll(() => {
    server.stop(true);
    app.shutdown();
});

class Client {
    cookie = "";
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
            // empty
        }
        return { status: res.status, data };
    }
    static async signUp(email: string, password = "correct horse") {
        const c = new Client();
        expect((await c.call("POST", "/api/auth/register", { email, displayName: "Teacher", password })).status).toBe(201);
        return c;
    }
    static async signIn(email: string, password: string) {
        const c = new Client();
        return { c, status: (await c.call("POST", "/api/auth/login", { email, password })).status };
    }
}

const settle = () => Bun.sleep(10);
const lastTo = (to: string) => sent.findLast((m) => m.to === to);
const tokenFrom = (m: EmailMessage) => /#token=([\w-]+)/.exec(m.text)![1]!;
const userId = (email: string) => (db.query("SELECT id FROM users WHERE email = ?").get(email) as { id: number } | null)?.id;

describe("account settings", () => {
    test("need a session; the confirm link doesn't", async () => {
        const anon = new Client();
        expect((await anon.call("GET", "/api/account")).status).toBe(401);
        expect((await anon.call("PATCH", "/api/account", { displayName: "x" })).status).toBe(401);
        expect((await anon.call("POST", "/api/account/delete", { password: "x" })).status).toBe(401);
        expect((await anon.call("POST", "/api/account/email/confirm", { token: "nope" })).status).toBe(400);
    });

    test("display name: trimmed, 1–60 characters", async () => {
        const c = await Client.signUp("name@example.com");
        expect((await c.call("PATCH", "/api/account", { displayName: "  Ms. Rivera " })).data.user.displayName).toBe("Ms. Rivera");
        expect((await c.call("PATCH", "/api/account", { displayName: " " })).status).toBe(400);
        expect((await c.call("PATCH", "/api/account", { displayName: "x".repeat(61) })).status).toBe(400);
        expect((await c.call("GET", "/api/me")).data.user.displayName).toBe("Ms. Rivera");
    });

    test("password: needs the current one, keeps this session, ends the others, and limits guesses", async () => {
        const c = await Client.signUp("pw@example.com");
        const { c: other } = await Client.signIn("pw@example.com", "correct horse");
        expect((await c.call("POST", "/api/account/password", { current: "wrong pass", password: "new password 1" })).status).toBe(403);
        expect((await c.call("POST", "/api/account/password", { current: "correct horse", password: "short" })).status).toBe(400);
        expect((await c.call("POST", "/api/account/password", { current: "correct horse", password: "new password 1" })).status).toBe(200);
        expect((await c.call("GET", "/api/me")).status).toBe(200);
        expect((await other.call("GET", "/api/me")).status).toBe(401);
        expect((await Client.signIn("pw@example.com", "correct horse")).status).toBe(401);
        expect((await Client.signIn("pw@example.com", "new password 1")).status).toBe(200);

        for (let i = 0; i < 5; i++) expect((await c.call("POST", "/api/account/password", { current: "guess", password: "another one 1" })).status).toBe(403);
        expect((await c.call("POST", "/api/account/password", { current: "new password 1", password: "another one 1" })).status).toBe(429);
    });

    test("email: confirmed by a link to the new address, with a notice to the old one", async () => {
        const c = await Client.signUp("old@example.com");
        await Client.signUp("taken@example.com");
        expect((await c.call("POST", "/api/account/email", { email: "taken@example.com", password: "correct horse" })).status).toBe(409);
        expect((await c.call("POST", "/api/account/email", { email: "OLD@example.com", password: "correct horse" })).status).toBe(400);
        expect((await c.call("POST", "/api/account/email", { email: "new@example.com", password: "wrong pass" })).status).toBe(403);

        const res = await c.call("POST", "/api/account/email", { email: " New@Example.com ", password: "correct horse" });
        expect(res.data.pendingEmail).toBe("new@example.com");
        expect((await c.call("GET", "/api/account")).data.pendingEmail).toBe("new@example.com");
        await settle();
        const link = lastTo("new@example.com")!;
        expect(link.subject).toBe("Confirm your new Grade Lake email address");
        expect(link.text).toContain("https://gradelake.test/confirm-email#token=");
        expect(lastTo("old@example.com")!.text).toContain("change its email address to new@example.com");

        // Nothing changes until the link is used; then it's used up.
        expect((await c.call("GET", "/api/me")).data.user.email).toBe("old@example.com");
        const token = tokenFrom(link);
        const anon = new Client();
        expect((await anon.call("POST", "/api/account/email/confirm", { token })).data.email).toBe("new@example.com");
        expect((await anon.call("POST", "/api/account/email/confirm", { token })).status).toBe(400);
        expect((await c.call("GET", "/api/me")).data.user.email).toBe("new@example.com");
        expect((await Client.signIn("new@example.com", "correct horse")).status).toBe(200);
        expect((await c.call("GET", "/api/account")).data.pendingEmail).toBeNull();
    });

    test("a pending change is cancelled by the user, by a password reset, and by the address being taken", async () => {
        const c = await Client.signUp("pending@example.com");
        const request = async (email: string) => {
            await c.call("POST", "/api/account/email", { email, password: "correct horse" });
            await settle();
            return tokenFrom(lastTo(email)!);
        };
        const cancelled = await request("one@example.com");
        expect((await c.call("DELETE", "/api/account/email")).data.pendingEmail).toBeNull();
        expect((await c.call("POST", "/api/account/email/confirm", { token: cancelled })).status).toBe(400);

        const reset = await request("two@example.com");
        await c.call("POST", "/api/auth/forgot", { email: "pending@example.com" });
        await settle();
        await new Client().call("POST", "/api/auth/reset", { token: tokenFrom(lastTo("pending@example.com")!), password: "fresh password" });
        expect((await c.call("POST", "/api/account/email/confirm", { token: reset })).status).toBe(400);

        const c2 = (await Client.signIn("pending@example.com", "fresh password")).c;
        await c2.call("POST", "/api/account/email", { email: "three@example.com", password: "fresh password" });
        await settle();
        const raced = tokenFrom(lastTo("three@example.com")!);
        await Client.signUp("three@example.com");
        expect((await c2.call("POST", "/api/account/email/confirm", { token: raced })).status).toBe(409);
        expect((await c2.call("GET", "/api/me")).data.user.email).toBe("pending@example.com");
    });

    test("delete: needs the password, deletes everything tied to the account, and emails a confirmation", async () => {
        const c = await Client.signUp("leaver@example.com");
        const content = JSON.stringify({ test: "Quiz", questions: [{ prompt: "2+2?", choices: ["3", "4"], answer: "B" }] });
        expect((await c.call("POST", "/api/materials", { name: "Quiz", type: "Quiz", content })).status).toBe(201);
        const id = userId("leaver@example.com")!;
        app.gradeRuns.start(id, { uploadName: "a.zip" });

        expect((await c.call("POST", "/api/account/delete", { password: "wrong pass" })).status).toBe(403);
        expect(userId("leaver@example.com")).toBe(id);

        const res = await c.call("POST", "/api/account/delete", { password: "correct horse" });
        expect(res.status).toBe(200);
        expect(c.cookie).toBe("gl_session=");
        expect(userId("leaver@example.com")).toBeUndefined();
        for (const table of ["sessions", "study_materials", "grade_runs", "usage_events"]) {
            const col = table === "study_materials" || table === "grade_runs" ? "owner_id" : "user_id";
            expect((db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(id) as { n: number }).n).toBe(0);
        }
        await settle();
        expect(lastTo("leaver@example.com")!.subject).toBe("Your Grade Lake account was deleted");
        // The address is free to register again.
        await Client.signUp("leaver@example.com");
    });

    test("delete: a subscriber's Stripe customer is deleted first; if Stripe fails, the account stays", async () => {
        const c = await Client.signUp("payer@example.com");
        db.query("UPDATE users SET stripe_customer_id = 'cus_payer', stripe_subscription_id = 'sub_1', subscription_status = 'active', plan = 'pro' WHERE email = 'payer@example.com'").run();

        failStripe = true;
        const failed = await c.call("POST", "/api/account/delete", { password: "correct horse" });
        expect(failed.status).toBe(502);
        expect(failed.data.error).toMatch(/hasn't been deleted/);
        expect(userId("payer@example.com")).toBeDefined();

        failStripe = false;
        expect((await c.call("POST", "/api/account/delete", { password: "correct horse" })).status).toBe(200);
        expect(deleted).toContain("cus_payer");
        expect(userId("payer@example.com")).toBeUndefined();
    });
});
