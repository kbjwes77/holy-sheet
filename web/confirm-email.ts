// Confirms an email change from the link sent to the new address. The token is in the fragment (never sent to the
// server with the page); it's dropped from the address bar and history, then posted when the user confirms.
import { $, api, errorText } from "./common.ts";

const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
history.replaceState(null, "", location.pathname);

const error = $("error");
const button = $<HTMLButtonElement>("submit");

function fail(text: string): void {
    error.textContent = text;
    error.classList.remove("d-none");
}

if (!token) {
    fail("This link is missing its confirmation code. Open the link from the email again.");
    button.disabled = true;
}

button.addEventListener("click", async () => {
    error.classList.add("d-none");
    button.disabled = true;
    try {
        const { email } = await api<{ email: string }>("/api/account/email/confirm", { method: "POST", body: { token } });
        $("done-email").textContent = email;
        $("done").classList.remove("d-none");
        button.classList.add("d-none");
        $("intro").classList.add("d-none");
    } catch (err) {
        fail(errorText(err));
        button.disabled = false;
    }
});
