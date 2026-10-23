import { initDrift } from "./drift.ts";

// A few boats drift through the calm divider.
const demo = document.getElementById("demo-app");
if (demo) {
    // The generator (QR codes, layout) loads only when the demo is near the viewport.
    const load = () => import("./demo.ts").then((m) => m.initDemo(demo));
    if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver(
            (e) => {
                if (!e.some((x) => x.isIntersecting)) return;
                io.disconnect();
                void load();
            },
            { rootMargin: "800px 0px" },
        );
        io.observe(demo);
    } else void load();
}

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
