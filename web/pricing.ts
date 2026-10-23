// The pricing page is public; once the visitor is signed in, the Pro button starts Checkout or opens the billing portal.
interface Me {
    plan: "free" | "pro";
    billing: { trialAvailable: boolean; manageable: boolean; status: string | null; periodEnd: number | null; cancelAtPeriodEnd: boolean };
}
type Interval = "monthly" | "yearly";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const proCta = $<HTMLButtonElement>("pro-cta");
const note = $("pro-note");
const error = $("pro-error");

let interval: Interval = "monthly";
const PRICES = { monthly: ["$5", "per month"], yearly: ["$40", "per year"] } as const;
for (const i of ["monthly", "yearly"] as const) {
    const b = $<HTMLButtonElement>(`int-${i}`);
    b.addEventListener("click", () => {
        interval = i;
        for (const j of ["monthly", "yearly"] as const) {
            $(`int-${j}`).classList.toggle("on", j === i);
            $(`int-${j}`).setAttribute("aria-pressed", String(j === i));
        }
        $("pro-amount").textContent = PRICES[i][0];
        $("pro-per").textContent = PRICES[i][1];
        if (proCta.textContent?.startsWith("Subscribe for")) proCta.textContent = `Subscribe for ${PRICES[i][0]}/${i === "yearly" ? "year" : "month"}`;
    });
}
const date = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

/** POSTs to a billing endpoint and follows the Stripe URL it returns. */
async function go(path: string, busy: string): Promise<void> {
    const label = proCta.textContent;
    proCta.disabled = true;
    proCta.textContent = busy;
    error.hidden = true;
    try {
        const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ interval }) });
        const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!res.ok || !data.url) throw new Error(data.error ?? `request failed (${res.status})`);
        location.assign(data.url);
    } catch (e) {
        error.textContent = e instanceof Error ? e.message : String(e);
        error.hidden = false;
        proCta.disabled = false;
        proCta.textContent = label;
    }
}

const checkout = () => go("/api/billing/checkout", "Opening checkout…");
const portal = () => go("/api/billing/portal", "Opening billing…");

// Signed out, the button is a sign-up that comes back here and starts Checkout.
let onClick: () => void | Promise<void> = () => location.assign(`/register?next=${encodeURIComponent("/pricing?checkout=1")}`);
proCta.addEventListener("click", () => void onClick());

fetch("/api/me")
    .then(async (r) => {
        if (!r.ok) return;
        const { user } = (await r.json()) as { user: Me };
        $("nav-login").hidden = true;
        const reg = $<HTMLAnchorElement>("nav-register");
        reg.href = "/dashboard";
        reg.textContent = "Dashboard";
        const free = $<HTMLAnchorElement>("free-cta");
        free.href = "/dashboard";
        free.textContent = "Go to your dashboard";

        if (user.plan === "pro") {
            proCta.textContent = "Manage subscription";
            const { status, periodEnd, cancelAtPeriodEnd } = user.billing;
            const until = periodEnd ? date(periodEnd) : null;
            note.textContent =
                status === "past_due" ? "Your last payment failed. Update your card in the portal to keep Pro."
                : cancelAtPeriodEnd && until ? `Pro until ${until}. You won't be charged again.`
                : status === "trialing" && until ? `Your free trial ends ${until}.`
                : until ? `Renews ${until}.`
                : "You're on Pro.";
            onClick = portal;
            return;
        }
        proCta.textContent = user.billing.trialAvailable ? "Start your 7-day free trial" : `Subscribe for ${PRICES[interval][0]}/${interval === "yearly" ? "year" : "month"}`;
        note.textContent = user.billing.trialAvailable ? "Card required. You won't be charged until the trial ends." : "You've used your free trial.";
        onClick = checkout;
        if (user.billing.manageable) {
            const link = document.createElement("a");
            link.href = "#";
            link.textContent = "Manage billing";
            link.addEventListener("click", (e) => {
                e.preventDefault();
                void portal();
            });
            note.append(" ", link);
        }
        // Back from sign-up with the intent to subscribe.
        if (new URLSearchParams(location.search).get("checkout") === "1") void checkout();
    })
    .catch(() => {});
