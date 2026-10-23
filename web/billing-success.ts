import { $, api, type Me, startPage } from "./common.ts";

// Checkout's redirect isn't proof of payment: wait for the webhook to make this account Pro.
await startPage("pricing");

const TIMEOUT_MS = 30_000;
const started = Date.now();
while (Date.now() - started < TIMEOUT_MS) {
    const { user } = await api<{ user: Me }>("/api/me");
    if (user.plan === "pro") {
        $("title").textContent = "You're on Pro";
        $("subtitle").textContent = user.billing.status === "trialing" ? "Your 7-day free trial has started. Grade as many sheets as you like." : "Thanks for subscribing. The grader is unlocked.";
        $("go").classList.remove("d-none");
        break;
    }
    await new Promise((r) => setTimeout(r, 2000));
}
if ($("go").classList.contains("d-none")) {
    $("title").textContent = "Still confirming your subscription";
    $("subtitle").textContent = "Stripe hasn't confirmed it yet. Your card is safe: reload this page in a minute, or check the Billing page. If Pro doesn't appear soon, contact us.";
    const go = $<HTMLAnchorElement>("go");
    go.href = "/pricing";
    go.textContent = "Back to pricing";
    go.classList.remove("d-none");
}
