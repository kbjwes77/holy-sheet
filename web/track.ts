// Counts a page view for Grade Lake's own analytics (server/analytics.ts): the path, the referring page (the server
// keeps only its domain) and any UTM tags. Nothing is sent when the browser asks not to be tracked.
const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
if (!nav.globalPrivacyControl && nav.doNotTrack !== "1") {
    const params = new URLSearchParams(location.search);
    const utm = { source: params.get("utm_source"), medium: params.get("utm_medium"), campaign: params.get("utm_campaign") };
    void fetch("/api/t", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: location.pathname, referrer: document.referrer, utm }),
        keepalive: true,
    }).catch(() => {});
}
