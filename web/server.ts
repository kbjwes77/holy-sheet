// Local server for the web apps: `bun run web`, then open the printed URL.
//   /        Sheet Generator (also builds to a standalone file: `bun run build:web`)
//   /grader  Grader: a GUI that drives the grading CLI (grade.ts) through web/grader-api.ts
// It listens on localhost only by default: the grader runs commands and uses the OpenRouter key.
// HOST adds one more address to listen on, e.g. HOST=100.93.67.7 for a Tailscale IP.
import { join } from "node:path";
import { createGraderApi } from "./grader-api.ts";
import grader from "./grader.html";
import index from "./index.html";

const root = join(import.meta.dir, "..");

// `bun --hot` re-runs this module on edits; stop the previous instance's CLIs first.
const g = globalThis as {
    graderApi?: ReturnType<typeof createGraderApi>;
    graderSignals?: boolean;
    servers?: Map<string, Bun.Server<unknown>>;
};
g.graderApi?.shutdown();
const api = (g.graderApi = createGraderApi({ root }));

const port = Number(process.env.PORT ?? 3000);
const options = {
    port,
    // Phone photos add up: allow large zips.
    maxRequestBodySize: 1024 * 1024 * 1024,
    routes: { "/": index, "/grader": grader, ...api.routes },
    development: true,
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
    else servers.set(hostname, Bun.serve({ ...options, hostname }));
}
for (const server of servers.values()) {
    console.log(`Sheet Generator: ${server.url}\nGrader:          ${new URL("/grader", server.url)}`);
}

if (!g.graderSignals) {
    g.graderSignals = true;
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => {
            g.graderApi?.shutdown();
            process.exit(0);
        });
    }
}
