import { initDrift } from "./drift.ts";

// A few boats drift through the calm divider.
initDrift(document.getElementById("drift")!, { count: innerWidth < 700 ? 4 : 6 });

// Signed-in visitors still see this page; its sign-in and sign-up links become a way back to the dashboard.
fetch("/api/me")
    .then((r) => {
        if (!r.ok) return;
        document.querySelectorAll<HTMLAnchorElement>('a[href="/register"]').forEach((a) => {
            a.href = "/dashboard";
            a.textContent = a.closest(".nav") ? "Dashboard" : a.classList.contains("btn") ? "Go to your dashboard" : "Dashboard";
        });
        document.querySelectorAll<HTMLAnchorElement>('a[href="/login"]').forEach((a) => (a.hidden = true));
    })
    .catch(() => {});
