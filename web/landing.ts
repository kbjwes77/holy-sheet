import { initDrift } from "./drift.ts";

// A few boats drift through the calm divider.
const demo = document.getElementById("demo-app");
if (demo) {
    // Print Sheets (QR codes, layout) loads only when the demo is near the viewport.
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

// The How-it-works demo video. Autoplays muted and loops on large screens once it scrolls
// into view; elsewhere it sits on its poster until tapped. Pausing is always honoured.
const demoVideo = document.querySelector<HTMLVideoElement>("[data-demo-video]");
if (demoVideo) {
    demoVideo.muted = true;
    const plate = demoVideo.closest(".how-plate");
    let inView = true;
    let manual = false; // visitor tapped play on their own (small screens, reduced motion)
    let stopped = false; // visitor paused it by hand
    const autoOK = () =>
        inView && matchMedia("(min-width: 861px)").matches && matchMedia("(prefers-reduced-motion: no-preference)").matches;
    const tick = () => {
        const want = (autoOK() || (manual && inView)) && !stopped;
        if (want && demoVideo.paused) void demoVideo.play().catch(() => {});
        else if (!want) demoVideo.pause();
    };
    demoVideo.closest(".mat")?.addEventListener("click", () => {
        if (demoVideo.paused) {
            manual = true;
            stopped = false;
        } else stopped = true;
        tick();
    });
    if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver(
            (e) => {
                inView = e.some((x) => x.isIntersecting);
                tick();
            },
            { rootMargin: "120px 0px" },
        );
        io.observe(demoVideo);
    }
    matchMedia("(min-width: 861px)").addEventListener("change", tick);
    matchMedia("(prefers-reduced-motion: no-preference)").addEventListener("change", tick);
    demoVideo.addEventListener("play", () => plate?.classList.add("playing"));
    demoVideo.addEventListener("pause", () => plate?.classList.remove("playing"));
}

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
