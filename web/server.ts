// The web server: `bun run web` (dev, hot reload) or `bun run start` (production), then open the URL.
//   /            Landing page (public; signed-in visitors get a link to /dashboard)
//   /pricing     Free vs Pro (public); Pro is a Stripe subscription (server/billing.ts)
//   /policy, /terms   Privacy policy and terms of service (public, static)
//   /dashboard   Dashboard (MOTD and links)         /login, /register   Accounts
//   /forgot-password, /reset-password   Password reset by emailed link (server/email.ts)
//   /library     My materials and groups           /browse             Published by the community
//   /generator   Print Sheets
//   /grader      Grader: a GUI that drives the grading CLI (grade.ts) through web/grader-api.ts
//   /results     Saved grading runs (server/grade-runs.ts); each reopens in the grader
// The landing page is public. The other pages are static shells; each checks /api/me and redirects to /login. Everything under
// /api needs a session, and the grader needs a plan that can grade.
// It listens on localhost only by default: the grader runs commands and uses the OpenRouter key.
// HOST adds one more address to listen on, e.g. HOST=100.93.67.7 for a Tailscale IP.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { billingOptionsFromEnv } from "../server/billing.ts";
import { openDb } from "../server/db.ts";
import { emailOptionsFromEnv } from "../server/email.ts";
import { createStatic } from "../server/static.ts";
import billingSuccess from "./billing-success.html";
import browse from "./browse.html";
import dashboard from "./dashboard.html";
import forgotPassword from "./forgot-password.html";
import landing from "./landing.html";
import generator from "./index.html";
import grader from "./grader.html";
import library from "./library.html";
import login from "./login.html";
import policy from "./policy.html";
import freeGenerator from "./free-generator.html";
import howToGrade from "./how-to-grade-handwritten.html";
import howToQuiz from "./how-to-make-a-quiz-with-ai.html";
import pricing from "./pricing.html";
import register from "./register.html";
import resetPassword from "./reset-password.html";
import results from "./results.html";
import slides from "./slides.html";
import vsGradescope from "./vs-gradescope.html";
import vsZipgrade from "./vs-zipgrade.html";
import testJsonFormat from "./test-json-format.html";
import terms from "./terms.html";

const root = join(import.meta.dir, "..");

// `bun --hot` re-runs this module on edits; stop the previous instance's CLIs first.
const production = process.env.NODE_ENV === "production";
const g = globalThis as {
    app?: ReturnType<typeof createApp>;
    graderSignals?: boolean;
    servers?: Map<string, Bun.Server<unknown>>;
};
g.app?.shutdown();
const dbPath = process.env.DB_PATH?.trim() || join(root, "data", "gradelake.db");
mkdirSync(join(dbPath, ".."), { recursive: true });
const app = (g.app = createApp({
    db: g.app ? g.app.db : openDb(dbPath),
    root,
    // Behind HTTPS in production the cookie is Secure; set INSECURE_COOKIES=1 to try production mode over plain http.
    secureCookies: production && process.env.INSECURE_COOKIES !== "1",
    adminEmails: (process.env.ADMIN_EMAILS ?? "").split(","),
    trustProxy: process.env.TRUST_PROXY === "1",
    billing: billingOptionsFromEnv(process.env),
    email: emailOptionsFromEnv(process.env),
}));

const port = Number(process.env.PORT ?? 3000);
const options = {
    port,
    // Phone photos add up: allow large zips.
    maxRequestBodySize: 1024 * 1024 * 1024,
    routes: { "/": landing, "/pricing": pricing, "/free-bubble-sheet-generator": freeGenerator, "/how-to/make-a-quiz-with-chatgpt-or-claude": howToQuiz, "/how-to/grade-handwritten-answers-with-ai": howToGrade, "/test-json-format": testJsonFormat, "/zipgrade-alternative": vsZipgrade, "/gradescope-alternative": vsGradescope, "/policy": policy, "/terms": terms, "/billing/success": billingSuccess, "/dashboard": dashboard, "/login": login, "/register": register, "/forgot-password": forgotPassword, "/reset-password": resetPassword, "/library": library, "/browse": browse, "/generator": generator, "/grader": grader, "/results": results, "/slides": slides, ...createStatic(join(root, "public"), production), ...app.routes },
    development: !production,
};
const hosts = [...new Set(["127.0.0.1", process.env.HOST?.trim()].filter((h): h is string => !!h))];

// On a hot reload, swap the routes on the running servers rather than binding the ports again.
const servers = (g.servers ??= new Map());
for (const [host, server] of servers) {
    if (!hosts.includes(host)) {
        server.stop(true);
        servers.delete(host);
    }
}
for (const hostname of hosts) {
    const server = servers.get(hostname);
    if (server) server.reload(options);
    else {
        try {
            servers.set(hostname, Bun.serve({ ...options, hostname }));
        } catch (e) {
            const hint = hostname === "127.0.0.1" ? "is the port in use?" : "HOST must be an address of this machine (e.g. 0.0.0.0 or a Tailscale IP), not a domain name";
            console.error(`Couldn't listen on ${hostname}:${port}: ${(e as Error).message} (${hint})`);
            process.exit(1);
        }
    }
}
for (const server of servers.values()) {
    console.log(`GradeLake: ${server.url}`);
}

if (!g.graderSignals) {
    g.graderSignals = true;
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => {
            g.app?.shutdown();
            process.exit(0);
        });
    }
}
