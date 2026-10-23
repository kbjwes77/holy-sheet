// Stripe billing: Checkout for the Pro subscription (monthly or yearly, with a one-time 7-day trial), the customer portal,
// and the webhook that keeps `users.plan` in step with Stripe. Access reads only `users.plan`; only webhooks write it.
import type { Database } from "bun:sqlite";
import Stripe from "stripe";
import type { Auth } from "./auth.ts";
import { now, recordUsage } from "./db.ts";
import { fail, json, readObject, sameOrigin } from "./http.ts";

/** Stripe's Endive release. Pinned here and by the exact `stripe` version in package.json; set the webhook destination to the same version. */
export const STRIPE_API_VERSION = "2026-09-30.endive";
export const TRIAL_DAYS = 7;
export const INTERVALS = ["monthly", "yearly"] as const;
export type Interval = (typeof INTERVALS)[number];
/** Subscription statuses that keep Pro: paying, in trial, or in Stripe's payment-retry window. */
const PRO_STATUSES = new Set(["active", "trialing", "past_due"]);

export interface BillingOptions {
    secretKey?: string;
    webhookSecret?: string;
    /** The recurring Prices of the Pro product, created in the Stripe dashboard. */
    priceMonthly?: string;
    priceYearly?: string;
    /** "sandbox" (test keys) or "live"; webhooks from the other environment are refused. */
    mode?: "sandbox" | "live";
    /** Public base URL for Checkout's return links (default: the request's origin). */
    publicUrl?: string;
    /** A prebuilt client, for tests. */
    stripe?: Stripe;
}

/**
 * Billing options from the environment. No STRIPE_* variables means billing is off (the endpoints answer 503);
 * any of them means all are required and must agree with STRIPE_MODE, so a half-set or mixed-up config fails at startup.
 */
export function billingOptionsFromEnv(env: Record<string, string | undefined>): BillingOptions | undefined {
    const get = (k: string) => env[k]?.trim() || undefined;
    const keys = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO_MONTHLY", "STRIPE_PRICE_PRO_YEARLY", "STRIPE_MODE"];
    if (!keys.some((k) => get(k))) return undefined;
    const missing = keys.filter((k) => !get(k));
    if (missing.length) throw new Error(`Stripe is partly configured; also set ${missing.join(", ")} (or unset the others)`);
    const mode = get("STRIPE_MODE");
    if (mode !== "sandbox" && mode !== "live") throw new Error('STRIPE_MODE must be "sandbox" or "live"');
    const secretKey = get("STRIPE_SECRET_KEY")!;
    const prefix = mode === "live" ? "sk_live_" : "sk_test_";
    if (!secretKey.startsWith(prefix)) throw new Error(`STRIPE_MODE=${mode} needs a ${prefix}… STRIPE_SECRET_KEY`);
    return { secretKey, webhookSecret: get("STRIPE_WEBHOOK_SECRET"), priceMonthly: get("STRIPE_PRICE_PRO_MONTHLY"), priceYearly: get("STRIPE_PRICE_PRO_YEARLY"), mode, publicUrl: get("APP_BASE_URL") };
}

interface UserRow {
    id: number;
    email: string;
    display_name: string;
    plan: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    subscription_status: string | null;
    subscription_created: number | null;
    trial_used_at: number | null;
}

export function createBilling(db: Database, auth: Auth, o: BillingOptions = {}) {
    const configured = !!(o.priceMonthly && o.priceYearly && o.webhookSecret && (o.stripe || o.secretKey));
    const stripe = o.stripe ?? (o.secretKey ? new Stripe(o.secretKey, { apiVersion: STRIPE_API_VERSION }) : null);
    const livemode = o.mode === "live";
    const unavailable = () => fail(503, "billing isn't set up on this server");

    const origin = (req: Request) => (o.publicUrl ?? new URL(req.url).origin).replace(/\/$/, "");
    const userRow = (id: number) =>
        db.query("SELECT id, email, display_name, plan, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_created, trial_used_at FROM users WHERE id = ?").get(id) as UserRow;

    async function ensureCustomer(row: UserRow, s: Stripe): Promise<string> {
        if (row.stripe_customer_id) return row.stripe_customer_id;
        const customer = await s.customers.create({ email: row.email, name: row.display_name, metadata: { userId: String(row.id) } }, { idempotencyKey: `customer-create-${row.id}` });
        db.query("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customer.id, row.id);
        return customer.id;
    }

    /** Trial is once per account: our flag, double-checked against the customer's Stripe history in case the flag was lost. */
    async function trialEligible(row: UserRow, customer: string, s: Stripe): Promise<boolean> {
        if (row.trial_used_at) return false;
        const subs = await s.subscriptions.list({ customer, status: "all", limit: 100 });
        const trials = subs.data.map((x) => x.trial_start).filter((t): t is number => t != null);
        if (trials.length) {
            db.query("UPDATE users SET trial_used_at = ? WHERE id = ?").run(Math.min(...trials), row.id);
            return false;
        }
        return true;
    }

    async function portalUrl(customer: string, req: Request, s: Stripe): Promise<string> {
        return (await s.billingPortal.sessions.create({ customer, return_url: `${origin(req)}/pricing` })).url;
    }

    async function checkout(req: Request): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        if (!configured || !stripe) return unavailable();
        const user = auth.requireUser(req);
        if (user instanceof Response) return user;
        const body = await readObject(req);
        if (body instanceof Response) return body;
        if (!INTERVALS.includes(body.interval as Interval)) return fail(400, 'interval must be "monthly" or "yearly"');
        const price = body.interval === "yearly" ? o.priceYearly! : o.priceMonthly!;
        const row = userRow(user.id);
        try {
            // Already subscribed: switching plans, cards and cancelling all happen in the portal, never a second subscription.
            if (row.stripe_customer_id && row.subscription_status && PRO_STATUSES.has(row.subscription_status)) return json({ url: await portalUrl(row.stripe_customer_id, req, stripe) });
            const customer = await ensureCustomer(row, stripe);
            const trial = await trialEligible(row, customer, stripe);
            const base = origin(req);
            const session = await stripe.checkout.sessions.create({
                mode: "subscription",
                customer,
                client_reference_id: String(row.id),
                line_items: [{ price, quantity: 1 }],
                payment_method_collection: "always",
                subscription_data: {
                    metadata: { userId: String(row.id) },
                    ...(trial ? { trial_period_days: TRIAL_DAYS, trial_settings: { end_behavior: { missing_payment_method: "cancel" } } } : {}),
                },
                success_url: `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${base}/pricing`,
            });
            if (!session.url) return fail(502, "Stripe didn't return a checkout link");
            return json({ url: session.url });
        } catch (e) {
            console.error("checkout failed:", e);
            return fail(502, "couldn't start checkout; try again in a moment");
        }
    }

    async function portal(req: Request): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        if (!configured || !stripe) return unavailable();
        const user = auth.requireUser(req);
        if (user instanceof Response) return user;
        const customer = userRow(user.id).stripe_customer_id;
        if (!customer) return fail(409, "you don't have a subscription to manage");
        try {
            return json({ url: await portalUrl(customer, req, stripe) });
        } catch (e) {
            console.error("portal failed:", e);
            return fail(502, "couldn't open the billing portal; try again in a moment");
        }
    }

    /** Stripe schedules a cancellation either as `cancel_at_period_end` or, as the portal does, with a `cancel_at` timestamp. */
    const scheduledCancel = (sub: Stripe.Subscription) => sub.cancel_at_period_end || sub.cancel_at != null;

    /** Writes a (freshly fetched) subscription's state onto its owner. Pro while it's active, trialing or past due. */
    function syncSubscription(sub: Stripe.Subscription): void {
        const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        let row = db.query("SELECT id FROM users WHERE stripe_customer_id = ?").get(customer) as { id: number } | null;
        const metaId = Number(sub.metadata?.userId);
        if (!row && metaId) {
            row = db.query("SELECT id FROM users WHERE id = ? AND stripe_customer_id IS NULL").get(metaId) as { id: number } | null;
            if (row) db.query("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customer, row.id);
        }
        if (!row) {
            console.error(`stripe: subscription ${sub.id} belongs to unknown customer ${customer}`);
            return;
        }
        const user = userRow(row.id);
        const pro = PRO_STATUSES.has(sub.status);
        if (user.stripe_subscription_id && user.stripe_subscription_id !== sub.id) {
            // Updates for an older subscription must not overwrite a newer one.
            if (user.subscription_created != null && sub.created < user.subscription_created) return;
            if (pro && user.subscription_status && PRO_STATUSES.has(user.subscription_status)) console.error(`stripe: user ${user.id} has two live subscriptions (${user.stripe_subscription_id}, ${sub.id})`);
        }
        const item = sub.items.data[0];
        const interval = item?.price.recurring?.interval;
        db.query(
            `UPDATE users SET plan = ?, stripe_subscription_id = ?, subscription_status = ?, subscription_created = ?, price_id = ?, billing_interval = ?,
                 current_period_end = ?, cancel_at_period_end = ?, trial_used_at = COALESCE(trial_used_at, ?) WHERE id = ?`,
        ).run(pro ? "pro" : "free", sub.id, sub.status, sub.created, item?.price.id ?? null, interval ?? null, item?.current_period_end ?? null, scheduledCancel(sub) ? 1 : 0, sub.trial_start ?? null, user.id);
        const plan = pro ? "pro" : "free";
        if (user.plan !== plan) recordUsage(db, user.id, `plan_${plan}`, 1, { subscription: sub.id, status: sub.status });
    }

    /** The subscription an event is about, re-fetched because events can arrive late, twice or out of order. */
    async function subscriptionFor(event: Stripe.Event, s: Stripe): Promise<Stripe.Subscription | null> {
        if (event.type === "checkout.session.completed") {
            const session = event.data.object;
            if (session.mode !== "subscription" || !session.subscription) return null;
            return s.subscriptions.retrieve(typeof session.subscription === "string" ? session.subscription : session.subscription.id);
        }
        if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
            const sent = event.data.object;
            try {
                return await s.subscriptions.retrieve(sent.id);
            } catch (e) {
                if (event.type === "customer.subscription.deleted") return sent;
                throw e;
            }
        }
        // customer.subscription.trial_will_end, invoice.paid and invoice.payment_failed change no access: Pro stays through
        // the retries and the UI reads the status from the subscription events.
        return null;
    }

    async function webhook(req: Request): Promise<Response> {
        if (!configured || !stripe) return unavailable();
        const signature = req.headers.get("stripe-signature");
        if (!signature) return fail(400, "missing signature");
        let event: Stripe.Event;
        try {
            event = await stripe.webhooks.constructEventAsync(await req.text(), signature, o.webhookSecret!);
        } catch {
            return fail(400, "invalid signature");
        }
        if (event.livemode !== livemode) return fail(400, "event is from the other Stripe environment");
        if (db.query("SELECT 1 FROM processed_stripe_events WHERE event_id = ?").get(event.id)) return json({ received: true });
        try {
            const sub = await subscriptionFor(event, stripe);
            db.transaction(() => {
                if (sub) syncSubscription(sub);
                db.query("INSERT OR IGNORE INTO processed_stripe_events (event_id, type, received_at) VALUES (?, ?, ?)").run(event.id, event.type, now());
            })();
        } catch (e) {
            // A 5xx makes Stripe retry the delivery.
            console.error(`webhook ${event.type} (${event.id}) failed:`, e);
            return fail(500, "couldn't process the event");
        }
        return json({ received: true });
    }

    const routes = {
        "/api/billing/checkout": { POST: checkout },
        "/api/billing/portal": { POST: portal },
        "/api/stripe/webhook": { POST: webhook },
    };
    return { routes, configured };
}
