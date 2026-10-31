// First-party analytics: a visitor cookie (gl_vid), page views sent by web/track.ts, the business events (sign-ups,
// materials, grading) recorded by the rest of the server, and the admin stats page's API.
//
// A visitor is a browser: its first external referrer (domain only), landing page and UTM tags are kept, and it is
// linked to an account when it signs up or signs in, so a sign-up's journey (the pages it saw before) can be shown.
// Events keep their counts when an account is deleted: its visitors are deleted, and its events (page views
// included) lose their user and visitor. Sign-ups, deletions and new materials are recorded by triggers (migration 8);
// grading is recorded by app.ts. Browsers sending Global Privacy Control or Do Not Track, bots
// and admins aren't tracked. Page views and anonymous visitors are kept for 13 months.
import type { Database } from "bun:sqlite";
import type { Auth } from "./auth.ts";
import { now } from "./db.ts";
import { fail, json, readObject, sameOrigin } from "./http.ts";

export const VISITOR_COOKIE = "gl_vid";
const VISITOR_TTL = 400 * 24 * 60 * 60;
const KEEP_SECONDS = 400 * 24 * 60 * 60;
const DAY = 24 * 60 * 60;
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl|wget|python|httpclient|monitor/i;
const VISITOR_RE = /^[\w-]{22}$/;

/** Business events recorded from code (the rest are triggers). `grade`'s quantity is the pages graded. */
export type EventKind = "grade";

export interface AnalyticsOptions {
    /** Adds `Secure` to the cookie (in production). */
    secureCookies?: boolean;
}

/** A referrer URL → its domain without "www.", or null for none, an internal link or something unparseable. */
export function referrerDomain(referrer: unknown, ownHost: string): string | null {
    if (typeof referrer !== "string" || !referrer) return null;
    try {
        const url = new URL(referrer);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        const host = url.hostname.toLowerCase().replace(/^www\./, "");
        return host && host !== ownHost.toLowerCase().replace(/^www\./, "") ? host.slice(0, 100) : null;
    } catch {
        return null;
    }
}

const clean = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export function createAnalytics(db: Database, auth: Auth, o: AnalyticsOptions = {}) {
    const cookieHeader = (id: string) => `${VISITOR_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${VISITOR_TTL}${o.secureCookies ? "; Secure" : ""}`;

    function visitorId(req: Request): string | null {
        for (const part of (req.headers.get("cookie") ?? "").split(";")) {
            const i = part.indexOf("=");
            if (i > 0 && part.slice(0, i).trim() === VISITOR_COOKIE) {
                const v = part.slice(i + 1).trim();
                return VISITOR_RE.test(v) ? v : null;
            }
        }
        return null;
    }

    const optedOut = (req: Request) => req.headers.get("sec-gpc") === "1" || req.headers.get("dnt") === "1" || BOT_RE.test(req.headers.get("user-agent") ?? "");

    /** The request's visitor, if it has a cookie for one we know. */
    function knownVisitor(req: Request): string | null {
        const id = visitorId(req);
        return id && db.query("SELECT 1 FROM visitors WHERE id = ?").get(id) ? id : null;
    }

    /** Records a business event, tied to the request's visitor when there is one. */
    function record(kind: EventKind, userId: number | null, opts: { req?: Request; quantity?: number } = {}): void {
        const visitor = opts.req ? knownVisitor(opts.req) : null;
        db.query("INSERT INTO analytics_events (visitor_id, user_id, kind, quantity, created_at) VALUES (?, ?, ?, ?, ?)").run(visitor, userId, kind, opts.quantity ?? 1, now());
    }

    /** Links the request's visitor to the account that just signed up or in, so its journey belongs to them. */
    function linkVisitor(req: Request, userId: number): void {
        const id = knownVisitor(req);
        if (!id) return;
        db.query("UPDATE visitors SET user_id = ? WHERE id = ? AND user_id IS NULL").run(userId, id);
        db.query("UPDATE analytics_events SET visitor_id = ? WHERE kind = 'signup' AND user_id = ? AND visitor_id IS NULL").run(id, userId);
    }

    /** POST /api/t {path, referrer, utm: {source, medium, campaign}}: a page view. */
    async function track(req: Request): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const body = await readObject(req, 4096);
        if (body instanceof Response) return body;
        const noContent = (headers?: HeadersInit) => new Response(null, { status: 204, headers });
        if (optedOut(req)) return noContent();
        const user = auth.userFrom(req);
        if (user?.isAdmin) return noContent();
        const path = clean(body.path, 200);
        if (!path?.startsWith("/") || path.startsWith("/api/")) return fail(400, "bad path");
        // The Host header, as sameOrigin uses: behind a proxy the request URL names the local address.
        const host = (req.headers.get("host") ?? new URL(req.url).host).replace(/:\d+$/, "");
        const referrer = referrerDomain(body.referrer, host);
        const utm = (body.utm && typeof body.utm === "object" ? body.utm : {}) as Record<string, unknown>;
        const t = now();

        let id = knownVisitor(req);
        let setCookie: string | undefined;
        if (!id) {
            id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
            db.query("INSERT INTO visitors (id, user_id, first_seen, last_seen, referrer, landing, utm_source, utm_medium, utm_campaign) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
                id,
                user?.id ?? null,
                t,
                t,
                referrer,
                path,
                clean(utm.source, 100),
                clean(utm.medium, 100),
                clean(utm.campaign, 100),
            );
            setCookie = cookieHeader(id);
        } else {
            db.query("UPDATE visitors SET last_seen = ?, user_id = COALESCE(user_id, ?) WHERE id = ?").run(t, user?.id ?? null, id);
        }
        db.query("INSERT INTO analytics_events (visitor_id, user_id, kind, path, referrer, created_at) VALUES (?, ?, 'pageview', ?, ?, ?)").run(id, user?.id ?? null, path, referrer, t);
        return noContent(setCookie ? { "set-cookie": setCookie } : undefined);
    }

    function purge(): void {
        const before = now() - KEEP_SECONDS;
        db.query("DELETE FROM analytics_events WHERE kind = 'pageview' AND created_at < ?").run(before);
        db.query("DELETE FROM visitors WHERE user_id IS NULL AND last_seen < ?").run(before);
    }
    purge();
    const timer = setInterval(purge, DAY * 1000);
    timer.unref?.();

    // ---- Stats (admins only)

    function requireAdmin(req: Request) {
        const user = auth.requireUser(req);
        if (user instanceof Response) return user;
        return user.isAdmin ? user : fail(403, "admins only");
    }

    /** GET /api/admin/stats?days=30: totals, a daily series, referrers, landing pages, a funnel and recent sign-ups. */
    function stats(req: Request): Response {
        const admin = requireAdmin(req);
        if (admin instanceof Response) return admin;
        const days = Math.min(365, Math.max(7, Number(new URL(req.url).searchParams.get("days")) || 30));
        const today = Math.floor(now() / DAY) * DAY;
        const from = today - (days - 1) * DAY;
        const count = (sql: string, ...args: (string | number)[]) => (db.query(sql).get(...args) as { n: number }).n;

        const totals = {
            accounts: count("SELECT COUNT(*) AS n FROM users"),
            pro: count("SELECT COUNT(*) AS n FROM users WHERE plan = 'pro'"),
            materials: count("SELECT COUNT(*) AS n FROM study_materials"),
            gradeRuns: count("SELECT COUNT(*) AS n FROM analytics_events WHERE kind = 'grade'"),
            pagesGraded: count("SELECT COALESCE(SUM(quantity), 0) AS n FROM analytics_events WHERE kind = 'grade'"),
            visitors: count("SELECT COUNT(*) AS n FROM visitors"),
        };

        // One row per day (UTC), zero-filled.
        type Day = { date: string; signups: number; accounts: number; materials: number; gradeRuns: number; pages: number; visitors: number; pageviews: number };
        const series: Day[] = [];
        const index = new Map<number, Day>();
        for (let t = from; t <= today; t += DAY) {
            const d: Day = { date: new Date(t * 1000).toISOString().slice(0, 10), signups: 0, accounts: 0, materials: 0, gradeRuns: 0, pages: 0, visitors: 0, pageviews: 0 };
            series.push(d);
            index.set(t, d);
        }
        const rows = db
            .query(
                `SELECT (created_at / ${DAY}) * ${DAY} AS day, kind, COUNT(*) AS n, COALESCE(SUM(quantity), 0) AS q, COUNT(DISTINCT visitor_id) AS v
                 FROM analytics_events WHERE created_at >= ? GROUP BY day, kind`,
            )
            .all(from) as { day: number; kind: string; n: number; q: number; v: number }[];
        for (const r of rows) {
            const d = index.get(r.day);
            if (!d) continue;
            if (r.kind === "signup") d.signups = r.n;
            else if (r.kind === "material") d.materials = r.n;
            else if (r.kind === "grade") {
                d.gradeRuns = r.n;
                d.pages = r.q;
            } else if (r.kind === "pageview") {
                d.pageviews = r.n;
                d.visitors = r.v;
            }
        }
        // Accounts at the end of each day: sign-ups less deletions, counted from the start.
        let accounts = count("SELECT COALESCE(SUM(CASE kind WHEN 'signup' THEN 1 ELSE -1 END), 0) AS n FROM analytics_events WHERE kind IN ('signup', 'account_deleted') AND created_at < ?", from);
        const deletions = new Map(
            (db.query(`SELECT (created_at / ${DAY}) * ${DAY} AS day, COUNT(*) AS n FROM analytics_events WHERE kind = 'account_deleted' AND created_at >= ? GROUP BY day`).all(from) as { day: number; n: number }[]).map((r) => [r.day, r.n]),
        );
        for (const [t, d] of index) {
            accounts += d.signups - (deletions.get(t) ?? 0);
            d.accounts = accounts;
        }

        // Where visitors first seen in the range came from, and how many of them signed up.
        const referrers = db
            .query(
                `SELECT COALESCE(referrer, '(direct)') AS name, COUNT(*) AS visitors, COUNT(user_id) AS signups
                 FROM visitors WHERE first_seen >= ? GROUP BY name ORDER BY visitors DESC LIMIT 20`,
            )
            .all(from);
        const campaigns = db
            .query(
                `SELECT utm_source AS source, utm_medium AS medium, utm_campaign AS campaign, COUNT(*) AS visitors, COUNT(user_id) AS signups
                 FROM visitors WHERE first_seen >= ? AND utm_source IS NOT NULL GROUP BY source, medium, campaign ORDER BY visitors DESC LIMIT 20`,
            )
            .all(from);
        const landings = db
            .query(`SELECT landing AS name, COUNT(*) AS visitors, COUNT(user_id) AS signups FROM visitors WHERE first_seen >= ? GROUP BY landing ORDER BY visitors DESC LIMIT 20`)
            .all(from);
        const pages = db
            .query(
                `SELECT path AS name, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors FROM analytics_events
                 WHERE kind = 'pageview' AND created_at >= ? GROUP BY path ORDER BY views DESC LIMIT 25`,
            )
            .all(from);

        // Of the accounts created in the range: how far each got.
        const funnel = db
            .query(
                `SELECT COUNT(*) AS signups,
                    COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM analytics_events m WHERE m.kind = 'material' AND m.user_id = u.id)) AS material,
                    COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM analytics_events g WHERE g.kind = 'grade' AND g.user_id = u.id)) AS graded,
                    COUNT(*) FILTER (WHERE u.plan = 'pro') AS pro
                 FROM users u WHERE u.created_at >= ?`,
            )
            .get(from) as { signups: number; material: number; graded: number; pro: number };
        const funnelVisitors = count("SELECT COUNT(*) AS n FROM visitors WHERE first_seen >= ?", from);

        const signups = (
            db
                .query(
                    `SELECT u.id, u.email, u.display_name AS displayName, u.plan, u.created_at AS createdAt,
                        v.referrer, v.landing, v.utm_source AS utmSource, v.utm_campaign AS utmCampaign, v.first_seen AS firstSeen,
                        (SELECT COUNT(*) FROM analytics_events e JOIN visitors w ON w.id = e.visitor_id WHERE w.user_id = u.id AND e.kind = 'pageview' AND e.created_at <= u.created_at) AS viewsBefore
                     FROM users u LEFT JOIN visitors v ON v.id = (SELECT id FROM visitors WHERE user_id = u.id ORDER BY first_seen LIMIT 1)
                     ORDER BY u.created_at DESC LIMIT 25`,
                )
                .all() as Record<string, unknown>[]
        );

        return json({ days, from, totals, series, referrers, campaigns, landings, pages, funnel: { visitors: funnelVisitors, ...funnel }, signups });
    }

    /** GET /api/admin/journey/:userId: the account's page views and events in order, across its browsers. */
    function journey(req: Request & { params: Record<string, string> }): Response {
        const admin = requireAdmin(req);
        if (admin instanceof Response) return admin;
        const userId = Number(req.params.userId);
        if (!Number.isInteger(userId)) return fail(404, "no such user");
        const events = db
            .query(
                `SELECT e.kind, e.path, e.referrer, e.quantity, e.created_at AS at, e.visitor_id AS visitor FROM analytics_events e
                 WHERE e.user_id = ? OR e.visitor_id IN (SELECT id FROM visitors WHERE user_id = ?)
                 ORDER BY e.created_at, e.id LIMIT 500`,
            )
            .all(userId, userId);
        return json({ events });
    }

    return {
        record,
        linkVisitor,
        routes: {
            "/api/t": { POST: track },
            "/api/admin/stats": { GET: stats },
            "/api/admin/journey/:userId": { GET: journey },
        },
        stop: () => clearInterval(timer),
    };
}

export type Analytics = ReturnType<typeof createAnalytics>;
