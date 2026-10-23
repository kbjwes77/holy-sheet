import { $, api, errorText, nextPage } from "./common.ts";

const next = new URLSearchParams(location.search).get("next");
if (next) $<HTMLAnchorElement>("alt-link").href = `/register?next=${encodeURIComponent(next)}`;

// Already signed in: go straight on.
fetch("/api/me").then((r) => {
    if (r.ok) location.replace(nextPage());
});

$("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const error = $("error");
    const button = $<HTMLButtonElement>("submit");
    error.classList.add("d-none");
    button.disabled = true;
    try {
        await api("/api/auth/login", { method: "POST", body: { email: $<HTMLInputElement>("email").value, password: $<HTMLInputElement>("password").value } });
        location.assign(nextPage());
    } catch (err) {
        error.textContent = errorText(err);
        error.classList.remove("d-none");
        button.disabled = false;
    }
});
