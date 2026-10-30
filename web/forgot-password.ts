import { $, api, errorText } from "./common.ts";

$("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const error = $("error");
    const button = $<HTMLButtonElement>("submit");
    const email = $<HTMLInputElement>("email").value.trim();
    error.classList.add("d-none");
    button.disabled = true;
    try {
        await api("/api/auth/forgot", { method: "POST", body: { email } });
        $("sent-email").textContent = email;
        $("form").classList.add("d-none");
        $("sent").classList.remove("d-none");
    } catch (err) {
        error.textContent = errorText(err);
        error.classList.remove("d-none");
        button.disabled = false;
    }
});
