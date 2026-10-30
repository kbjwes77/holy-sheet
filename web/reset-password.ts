import { $, api, errorText } from "./common.ts";

// The emailed link carries the token in the fragment (never sent to the server); drop it from the address bar and history.
const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
history.replaceState(null, "", location.pathname);

if (!token) {
    $("error").textContent = "This link is missing its reset code. Open the link from the email again, or request a new one.";
    $("error").classList.remove("d-none");
    $<HTMLButtonElement>("submit").disabled = true;
}

$("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const error = $("error");
    const button = $<HTMLButtonElement>("submit");
    error.classList.add("d-none");
    button.disabled = true;
    try {
        await api("/api/auth/reset", { method: "POST", body: { token, password: $<HTMLInputElement>("password").value } });
        location.assign("/dashboard");
    } catch (err) {
        error.textContent = errorText(err);
        error.classList.remove("d-none");
        button.disabled = false;
    }
});
