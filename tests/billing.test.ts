// Stripe billing: checkout and portal sessions, and the webhook that sets the plan. Stripe's network calls are stubbed;
// webhook signatures are real (made with the SDK's test-header helper).
import { afterAll, describe, expect, test } from "bun:test";
import Stripe from "stripe";
import { createApp } from "../server/app.ts";
import { billingOptionsFromEnv } from "../server/billing.ts";
import { openDb } from "../server/db.ts";

const SECRET = "whsec_test";
const stripe = new Stripe("sk_test_dummy");
const calls = { checkout: [] as any[], portal: [] as any[], customers: [] as any[] };
const subs = new Map<string, any>();
let history: any[] = [];
(stripe as any).customers = { create: async (p: any, opts: any) => (calls.customers.push({ p, opts }), { id: `cus_${calls.customers.length}` }) };
(stripe as any).checkout = { sessions: { create: async (p: any) => (calls.checkout.push(p), { url: "https://checkout.stripe.test/s" }) } };
(stripe as any).billingPortal = { sessions: { create: async (p: any) => (calls.portal.push(p), { url: "https://billing.stripe.test/p" }) } };
(stripe as any).subscriptions = {
    retrieve: async (id: string) => {
        if (!subs.has(id)) throw new Error("no such subscription");
        return subs.get(id);
    },
    list: async () => ({ data: history }),
};

const db = openDb(":memory:");
const app = createApp({ db, root: process.cwd(), signUpsPerHour: 1000, billing: { stripe, webhookSecret: SECRET, priceMonthly: "price_m", priceYearly: "price_y", mode: "sandbox" } });
const server = Bun.serve({ port: 0, routes: app.routes });
const base = server.url.origin;
afterAll(() => {
    server.stop(true);
    app.shutdown();
});

class Client {
    cookie = "";
    async call(method: string, path: string, body?: unknown) {
        const res = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(this.cookie ? { cookie: this.cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const set = res.headers.get("set-cookie");
        if (set) this.cookie = set.split(";")[0]!;
        const text = await res.text();
        let data: any = text;
        try {
            data = JSON.parse(text);
        } catch {}
        return { status: res.status, data };
    }
    async signUp(email: string) {
        await this.call("POST", "/api/auth/register", { email, displayName: "T", password: "correct horse" });
        return this;
    }
    checkout(interval: unknown = "monthly") {
        return this.call("POST", "/api/billing/checkout", { interval });
    }
}

let eventSeq = 0;
async function send(event: { id?: string; type: string; object: unknown; livemode?: boolean }, signed = true) {
    const payload = JSON.stringify({ id: event.id ?? `evt_${++eventSeq}`, object: "event", type: event.type, livemode: event.livemode ?? false, data: { object: event.object } });
    const header = signed ? await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: SECRET }) : "t=1,v1=bad";
    return (await fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": header }, body: payload })).status;
}
/** Registers a subscription with the stubbed Stripe API and returns it. */
function subscribe(customer: string, status: string, over: Record<string, unknown> = {}) {
    const sub = {
        id: "sub_1",
        object: "subscription",
        customer,
        status,
        created: 1000,
        metadata: {},
        cancel_at_period_end: false,
        cancel_at: null,
        trial_start: null,
        items: { data: [{ price: { id: "price_m", recurring: { interval: "month" } }, current_period_end: 5000 }] },
        ...over,
    };
    subs.set(sub.id, sub);
    return sub;
}
const update = (customer: string, status: string, over: Record<string, unknown> = {}, type = "customer.subscription.updated") => send({ type, object: subscribe(customer, status, over) });
const me = async (c: Client) => (await c.call("GET", "/api/me")).data.user;
const plan = async (c: Client) => (await me(c)).plan as string;
const lastCustomer = () => `cus_${calls.customers.length}`;

describe("checkout", () => {
    test("needs a session and a valid interval, and maps it to a price server-side", async () => {
        expect((await new Client().checkout()).status).toBe(401);
        const c = await new Client().signUp("a@example.com");
        expect((await c.checkout("weekly")).status).toBe(400);
        expect((await c.call("POST", "/api/billing/checkout", { interval: "yearly", price: "price_evil" })).status).toBe(200);
        expect(calls.checkout.at(-1).line_items).toEqual([{ price: "price_y", quantity: 1 }]);
        expect((await c.checkout("monthly")).data.url).toBe("https://checkout.stripe.test/s");
        const p = calls.checkout.at(-1);
        expect(p).toMatchObject({ mode: "subscription", customer: lastCustomer(), payment_method_collection: "always", success_url: `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${base}/pricing` });
        expect(p.line_items).toEqual([{ price: "price_m", quantity: 1 }]);
        expect(p.allow_promotion_codes).toBeUndefined();
        expect(p.subscription_data).toMatchObject({ trial_period_days: 7, trial_settings: { end_behavior: { missing_payment_method: "cancel" } } });
        expect(calls.customers.at(-1).opts.idempotencyKey).toMatch(/^customer-create-\d+$/);
        expect(calls.customers).toHaveLength(1);
        expect((await me(c)).billing).toMatchObject({ trialAvailable: true, manageable: true });
    });

    test("never grants access itself", async () => {
        const c = await new Client().signUp("grant@example.com");
        await c.checkout();
        expect(await plan(c)).toBe("free");
    });

    test("a trial is offered once: after a subscription with a trial, and from Stripe's history when our flag is lost", async () => {
        const c = await new Client().signUp("b@example.com");
        await c.checkout();
        const customer = lastCustomer();
        await update(customer, "trialing", { trial_start: 2000 }, "customer.subscription.created");
        expect(await plan(c)).toBe("pro");
        expect((await me(c)).billing.trialAvailable).toBe(false);
        await update(customer, "canceled", { trial_start: 2000 }, "customer.subscription.deleted");
        expect(await plan(c)).toBe("free");
        await c.checkout();
        expect(calls.checkout.at(-1).subscription_data.trial_period_days).toBeUndefined();

        const d = await new Client().signUp("lost-flag@example.com");
        history = [{ trial_start: 1500 }, { trial_start: 900 }];
        await d.checkout();
        history = [];
        expect(calls.checkout.at(-1).subscription_data.trial_period_days).toBeUndefined();
        expect(db.query("SELECT trial_used_at FROM users WHERE email = ?").get("lost-flag@example.com")).toEqual({ trial_used_at: 900 });
    });

    test("an existing subscriber is sent to the portal instead of a second subscription", async () => {
        const c = await new Client().signUp("dup@example.com");
        await c.checkout();
        await update(lastCustomer(), "active", { id: "sub_dup" });
        const before = calls.checkout.length;
        const r = await c.checkout("yearly");
        expect(r.data.url).toBe("https://billing.stripe.test/p");
        expect(calls.checkout).toHaveLength(before);
    });
});

describe("webhook", () => {
    test("sets the plan from the subscription status, keeping Pro while past due", async () => {
        const c = await new Client().signUp("c@example.com");
        await c.checkout();
        const customer = lastCustomer();
        for (const [status, expected] of [["trialing", "pro"], ["active", "pro"], ["past_due", "pro"], ["unpaid", "free"], ["active", "pro"], ["canceled", "free"], ["incomplete_expired", "free"], ["paused", "free"]] as const) {
            expect(await update(customer, status)).toBe(200);
            expect(await plan(c)).toBe(expected);
        }
    });

    test("records the subscription's details for the UI", async () => {
        const c = await new Client().signUp("ui@example.com");
        await c.checkout();
        await update(lastCustomer(), "active", { id: "sub_ui", cancel_at_period_end: true, items: { data: [{ price: { id: "price_y", recurring: { interval: "year" } }, current_period_end: 7777 }] } });
        expect((await me(c)).billing).toMatchObject({ status: "active", interval: "year", periodEnd: 7777, cancelAtPeriodEnd: true });
        expect(db.query("SELECT price_id, subscription_created FROM users WHERE email = ?").get("ui@example.com")).toEqual({ price_id: "price_y", subscription_created: 1000 });
    });

    test("a cancellation scheduled with cancel_at (as the portal does) keeps Pro and shows as cancelling", async () => {
        const c = await new Client().signUp("portal-cancel@example.com");
        await c.checkout();
        await update(lastCustomer(), "trialing", { id: "sub_pc", cancel_at: 5000, cancel_at_period_end: false });
        expect(await plan(c)).toBe("pro");
        expect((await me(c)).billing).toMatchObject({ status: "trialing", cancelAtPeriodEnd: true });
        await update(lastCustomer(), "canceled", { id: "sub_pc", cancel_at: 5000 }, "customer.subscription.deleted");
        expect(await plan(c)).toBe("free");
    });

    test("checkout.session.completed syncs the subscription it names", async () => {
        const c = await new Client().signUp("d@example.com");
        await c.checkout();
        subscribe(lastCustomer(), "trialing", { id: "sub_cs" });
        expect(await send({ type: "checkout.session.completed", object: { id: "cs_1", object: "checkout.session", mode: "subscription", subscription: "sub_cs" } })).toBe(200);
        expect(await plan(c)).toBe("pro");
    });

    test("falls back to the userId in metadata when the customer isn't linked yet", async () => {
        const c = await new Client().signUp("meta@example.com");
        const id = (db.query("SELECT id FROM users WHERE email = ?").get("meta@example.com") as { id: number }).id;
        expect(await update("cus_unlinked", "active", { id: "sub_meta", metadata: { userId: String(id) } })).toBe(200);
        expect(await plan(c)).toBe("pro");
    });

    test("ignores updates for an older subscription", async () => {
        const c = await new Client().signUp("e@example.com");
        await c.checkout();
        const customer = lastCustomer();
        await update(customer, "active", { id: "sub_new", created: 2000 });
        await update(customer, "canceled", { id: "sub_old", created: 1000 });
        expect(await plan(c)).toBe("pro");
        expect(db.query("SELECT stripe_subscription_id FROM users WHERE email = ?").get("e@example.com")).toEqual({ stripe_subscription_id: "sub_new" });
    });

    test("is idempotent: a replayed event is not processed twice", async () => {
        const c = await new Client().signUp("f@example.com");
        await c.checkout();
        const event = { id: "evt_replay", type: "customer.subscription.updated", object: subscribe(lastCustomer(), "active", { id: "sub_r" }) };
        expect(await send(event)).toBe(200);
        expect(await plan(c)).toBe("pro");
        // Change the plan out of band, then replay: if the event were processed again the plan would flip back to pro.
        db.query("UPDATE users SET plan = 'free' WHERE email = ?").run("f@example.com");
        expect(await send(event)).toBe(200);
        expect(await plan(c)).toBe("free");
        expect(db.query("SELECT COUNT(*) AS n FROM processed_stripe_events WHERE event_id = 'evt_replay'").get()).toEqual({ n: 1 });
    });

    test("refuses bad signatures and the other environment's events, and changes nothing", async () => {
        const c = await new Client().signUp("g@example.com");
        await c.checkout();
        const object = subscribe(lastCustomer(), "active", { id: "sub_g" });
        expect(await send({ type: "customer.subscription.updated", object }, false)).toBe(400);
        expect(await send({ type: "customer.subscription.updated", object, livemode: true })).toBe(400);
        expect(await plan(c)).toBe("free");
    });

    test("answers 5xx when Stripe can't be reached so the delivery is retried, and ignores events that change no access", async () => {
        const c = await new Client().signUp("h@example.com");
        await c.checkout();
        const event = { id: "evt_retry", type: "customer.subscription.updated", object: { id: "sub_missing", customer: lastCustomer(), status: "active" } };
        expect(await send(event)).toBe(500);
        expect(db.query("SELECT 1 FROM processed_stripe_events WHERE event_id = 'evt_retry'").get()).toBeNull();
        for (const type of ["invoice.payment_failed", "invoice.paid", "customer.subscription.trial_will_end"]) expect(await send({ type, object: { id: "x" } })).toBe(200);
        expect(await plan(c)).toBe("free");
    });
});

describe("portal and configuration", () => {
    test("the portal needs a customer", async () => {
        const c = await new Client().signUp("i@example.com");
        expect((await c.call("POST", "/api/billing/portal", {})).status).toBe(409);
        await c.checkout();
        const r = await c.call("POST", "/api/billing/portal", {});
        expect(r.data.url).toBe("https://billing.stripe.test/p");
        expect(calls.portal.at(-1).return_url).toBe(`${base}/pricing`);
    });

    test("grading follows the plan, which only the webhook changes", async () => {
        const c = await new Client().signUp("gate@example.com");
        expect((await me(c)).canGrade).toBe(false);
        await c.checkout();
        expect((await me(c)).canGrade).toBe(false);
        await update(lastCustomer(), "active", { id: "sub_gate" });
        expect((await me(c)).canGrade).toBe(true);
        await update(lastCustomer(), "canceled", { id: "sub_gate" });
        expect((await me(c)).canGrade).toBe(false);
    });

    test("without Stripe configured the endpoints answer 503", async () => {
        const plain = createApp({ db: openDb(":memory:"), root: process.cwd() });
        const s = Bun.serve({ port: 0, routes: plain.routes });
        try {
            expect((await fetch(`${s.url.origin}/api/stripe/webhook`, { method: "POST", body: "{}" })).status).toBe(503);
        } finally {
            s.stop(true);
            plain.shutdown();
        }
    });

    test("the environment config fails fast when partial or mismatched", () => {
        const full = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_PRO_MONTHLY: "price_m", STRIPE_PRICE_PRO_YEARLY: "price_y", STRIPE_MODE: "sandbox" };
        expect(billingOptionsFromEnv({})).toBeUndefined();
        expect(billingOptionsFromEnv(full)).toMatchObject({ mode: "sandbox", priceMonthly: "price_m", priceYearly: "price_y" });
        expect(() => billingOptionsFromEnv({ ...full, STRIPE_PRICE_PRO_YEARLY: "" })).toThrow("STRIPE_PRICE_PRO_YEARLY");
        expect(() => billingOptionsFromEnv({ ...full, STRIPE_MODE: "live" })).toThrow("sk_live_");
        expect(() => billingOptionsFromEnv({ ...full, STRIPE_SECRET_KEY: "sk_live_x" })).toThrow("sk_test_");
        expect(() => billingOptionsFromEnv({ ...full, STRIPE_MODE: "staging" })).toThrow("STRIPE_MODE");
    });
});
