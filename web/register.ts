import { $, api, errorText, nextPage } from "./common.ts";

const next = new URLSearchParams(location.search).get("next");
if (next) $<HTMLAnchorElement>("alt-link").href = `/login?next=${encodeURIComponent(next)}`;

$("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const error = $("error");
    const button = $<HTMLButtonElement>("submit");
    error.classList.add("d-none");
    button.disabled = true;
    try {
        await api("/api/auth/register", {
            method: "POST",
            body: { displayName: $<HTMLInputElement>("name").value, email: $<HTMLInputElement>("email").value, password: $<HTMLInputElement>("password").value },
        });
        location.assign(nextPage());
    } catch (err) {
        error.textContent = errorText(err);
        error.classList.remove("d-none");
        button.disabled = false;
    }
});
