// The web server: `bun run web` (dev, hot reload) or `bun run start` (production), then open the URL.
//   /            Dashboard (MOTD and links)         /login, /register   Accounts
//   /library     My materials and groups           /browse             Published by the community
//   /generator   Sheet Generator
//   /grader      Grader: a GUI that drives the grading CLI (grade.ts) through web/grader-api.ts
// The pages are static shells; each checks /api/me and redirects to /login. Everything under
// /api needs a session, and the grader needs a plan that can grade.
// It listens on localhost only by default: the grader runs commands and uses the OpenRouter key.
// HOST adds one more address to listen on, e.g. HOST=100.93.67.7 for a Tailscale IP.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import { createStatic } from "../server/static.ts";
import browse from "./browse.html";
import dashboard from "./dashboard.html";
import generator from "./index.html";
import grader from "./grader.html";
import library from "./library.html";
import login from "./login.html";
import register from "./register.html";

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
}));

const port = Number(process.env.PORT ?? 3000);
const options = {
    port,
    // Phone photos add up: allow large zips.
    maxRequestBodySize: 1024 * 1024 * 1024,
    routes: { "/": dashboard, "/login": login, "/register": register, "/library": library, "/browse": browse, "/generator": generator, "/grader": grader, ...createStatic(join(root, "public"), production), ...app.routes },
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
