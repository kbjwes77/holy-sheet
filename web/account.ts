// Account settings: display name, email address (changed once the new address is confirmed), password, and
// deleting the account. The API is server/account.ts.
import { $, api, errorText, startPage, type Me } from "./common.ts";

const { me } = await startPage("account");

type Kind = "success" | "danger" | "info";

function note(id: string, kind: Kind, text: string): void {
    const box = $(id);
    box.className = `alert theme-${kind} mt-4 mb-0`;
    box.textContent = text;
}

/** Runs a form's request with its submit button disabled, reporting failure in the form's status box. */
function onSubmit(formId: string, statusId: string, run: () => Promise<void>): void {
    const form = $<HTMLFormElement>(formId);
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        $(statusId).classList.add("d-none");
        button.disabled = true;
        try {
            await run();
        } catch (err) {
            note(statusId, "danger", errorText(err));
        } finally {
            button.disabled = false;
        }
    });
}

// ---- Display name

const nameInput = $<HTMLInputElement>("display-name");
nameInput.value = me.displayName;
onSubmit("name-form", "name-status", async () => {
    const { user } = await api<{ user: Me }>("/api/account", { method: "PATCH", body: { displayName: nameInput.value } });
    nameInput.value = user.displayName;
    note("name-status", "success", "Saved.");
});

// ---- Email

$("current-email").textContent = me.email;

function showPending(email: string | null): void {
    $("pending-email").textContent = email ?? "";
    $("email-pending").classList.toggle("d-none", !email);
}

api<{ pendingEmail: string | null }>("/api/account")
    .then(({ pendingEmail }) => showPending(pendingEmail))
    .catch(() => {});

onSubmit("email-form", "email-status", async () => {
    const email = $<HTMLInputElement>("new-email").value.trim();
    const { pendingEmail } = await api<{ pendingEmail: string }>("/api/account/email", { method: "POST", body: { email, password: $<HTMLInputElement>("email-password").value } });
    $<HTMLFormElement>("email-form").reset();
    showPending(pendingEmail);
});

$("btn-cancel-email").addEventListener("click", async () => {
    try {
        await api("/api/account/email", { method: "DELETE" });
        showPending(null);
        note("email-status", "info", "The email change was cancelled; the link no longer works.");
    } catch (err) {
        note("email-status", "danger", errorText(err));
    }
});

// ---- Password

onSubmit("password-form", "password-status", async () => {
    await api("/api/account/password", { method: "POST", body: { current: $<HTMLInputElement>("current-password").value, password: $<HTMLInputElement>("new-password").value } });
    $<HTMLFormElement>("password-form").reset();
    note("password-status", "success", "Your password was changed, and your other devices were signed out.");
});

// ---- Delete

const subscribed = me.plan === "pro" && !!me.billing.status && ["active", "trialing", "past_due"].includes(me.billing.status);
$("delete-billing").classList.toggle("d-none", !subscribed);

onSubmit("delete-form", "delete-status", async () => {
    const warning = subscribed
        ? "Delete your account, your library and your saved results, and end your Pro subscription now? This can't be undone."
        : "Delete your account, your library and your saved results? This can't be undone.";
    if (!confirm(warning)) return;
    await api("/api/account/delete", { method: "POST", body: { password: $<HTMLInputElement>("delete-password").value } });
    location.assign("/");
});
