// Accounts and sessions. A session is a random token in an HttpOnly cookie; only its SHA-256 is
// stored. Sessions last 30 days from last use (sliding), and expired rows are purged hourly.
import type { Database } from "bun:sqlite";
import { fail, json, readObject, sameOrigin } from "./http.ts";
import { getSetting, now, recordUsage, setSetting, usageSince, type Plan } from "./db.ts";

export const COOKIE = "gl_session";
export const SESSION_TTL = 30 * 24 * 60 * 60;
/** A session's expiry is only pushed out when it has been this long since the last push. */
const TOUCH_AFTER = 60 * 60;
const MAX_PASSWORD = 200;
const MIN_PASSWORD = 8;
const MAX_MOTD = 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface User {
    id: number;
    email: string;
    displayName: string;
    plan: Plan;
    isAdmin: boolean;
}

export interface AuthOptions {
    /** Adds `Secure` to the cookie (set when served over HTTPS, i.e. in production). */
    secureCookies?: boolean;
    /** Emails that become admins when they register. */
    adminEmails?: string[];
    /** Trust X-Forwarded-For for the client address (behind a reverse proxy). */
    trustProxy?: boolean;
    /** Sign-ups allowed per address per hour (default 10). */
    signUpsPerHour?: number;
}

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** Failed-attempt limiter: `max` tries per `windowMs` for a key. */
class RateLimit {
    private hits = new Map<string, number[]>();
    constructor(
        private max: number,
        private windowMs: number,
    ) {}
    blocked(key: string): boolean {
        const t = Date.now() - this.windowMs;
        const list = (this.hits.get(key) ?? []).filter((x) => x > t);
        this.hits.set(key, list);
        return list.length >= this.max;
    }
    hit(key: string): void {
        this.hits.set(key, [...(this.hits.get(key) ?? []), Date.now()]);
    }
    clear(key: string): void {
        this.hits.delete(key);
    }
    sweep(): void {
        const t = Date.now() - this.windowMs;
        for (const [k, v] of this.hits) if (!v.some((x) => x > t)) this.hits.delete(k);
    }
}

export function createAuth(db: Database, opts: AuthOptions = {}) {
    const admins = new Set((opts.adminEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
    const loginLimit = new RateLimit(10, 15 * 60_000);
    const registerLimit = new RateLimit(opts.signUpsPerHour ?? 10, 60 * 60_000);
    // Verified against when the email is unknown, so a miss takes as long as a wrong password.
    const dummyHash = Bun.password.hashSync("not-a-real-password");

    const purge = () => {
        db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now());
        loginLimit.sweep();
        registerLimit.sweep();
    };
    purge();
    const timer = setInterval(purge, 60 * 60_000);
    timer.unref?.();

    function clientKey(req: Request, server: Bun.Server<unknown> | null): string {
        if (opts.trustProxy) {
            const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
            if (fwd) return fwd;
        }
        return server?.requestIP(req)?.address ?? "unknown";
    }

    function cookieHeader(value: string, maxAge: number): string {
        return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${opts.secureCookies ? "; Secure" : ""}`;
    }

    function readToken(req: Request): string | null {
        const header = req.headers.get("cookie");
        if (!header) return null;
        for (const part of header.split(";")) {
            const i = part.indexOf("=");
            if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
        }
        return null;
    }

    /** Starts a session and returns the Set-Cookie header value. */
    function startSession(userId: number): string {
        const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
        const t = now();
        db.query("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(sha256(token), userId, t, t, t + SESSION_TTL);
        return cookieHeader(token, SESSION_TTL);
    }

    /** The signed-in user for a request, extending their session if it hasn't been touched lately. */
    function userFrom(req: Request): User | null {
        const token = readToken(req);
        if (!token) return null;
        const hash = sha256(token);
        const row = db
            .query(
                `SELECT u.id, u.email, u.display_name, u.plan, u.is_admin, s.last_seen_at
                 FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = ? AND s.expires_at > ?`,
            )
            .get(hash, now()) as { id: number; email: string; display_name: string; plan: Plan; is_admin: number; last_seen_at: number } | null;
        if (!row) return null;
        const t = now();
        if (t - row.last_seen_at > TOUCH_AFTER) db.query("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").run(t, t + SESSION_TTL, hash);
        return { id: row.id, email: row.email, displayName: row.display_name, plan: row.plan, isAdmin: !!row.is_admin };
    }

    /** The signed-in user, or a 401 response. */
    function requireUser(req: Request): User | Response {
        return userFrom(req) ?? fail(401, "not signed in");
    }

    /** The one place plan/quota rules for grading live (Stripe will extend this). */
    function canGrade(user: User): boolean {
        return user.plan === "pro" || user.isAdmin;
    }

    /** The signed-in user if their plan may grade, else a 401/402 response. */
    function requireGrader(req: Request): User | Response {
        const user = requireUser(req);
        if (user instanceof Response) return user;
        return canGrade(user) ? user : fail(402, "grading needs a Pro plan");
    }

    function monthStart(): number {
        const d = new Date();
        return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
    }

    function publicUser(user: User) {
        return {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            plan: user.plan,
            isAdmin: user.isAdmin,
            canGrade: canGrade(user),
            usage: { gradeRunsThisMonth: usageSince(db, user.id, "grade_run", monthStart()) },
        };
    }

    async function register(req: Request, server: Bun.Server<unknown>): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const ip = clientKey(req, server);
        if (registerLimit.blocked(ip)) return fail(429, "too many sign-ups from this address; try again later");
        const body = await readObject(req);
        if (body instanceof Response) return body;
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!EMAIL_RE.test(email) || email.length > 254) return fail(400, "enter a valid email address");
        if (!displayName || displayName.length > 60) return fail(400, "the display name must be 1–60 characters");
        if (password.length < MIN_PASSWORD) return fail(400, `the password must be at least ${MIN_PASSWORD} characters`);
        if (password.length > MAX_PASSWORD) return fail(400, `the password must be at most ${MAX_PASSWORD} characters`);
        registerLimit.hit(ip);
        if (db.query("SELECT 1 FROM users WHERE email = ?").get(email)) return fail(409, "an account with that email already exists");
        const hash = await Bun.password.hash(password);
        let id: number;
        try {
            id = Number(
                db
                    .query("INSERT INTO users (email, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)")
                    .run(email, displayName, hash, admins.has(email) ? 1 : 0, now()).lastInsertRowid,
            );
        } catch {
            return fail(409, "an account with that email already exists");
        }
        recordUsage(db, id, "register");
        return json({ ok: true }, 201, { "set-cookie": startSession(id) });
    }

    async function login(req: Request, server: Bun.Server<unknown>): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const body = await readObject(req);
        if (body instanceof Response) return body;
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const password = typeof body.password === "string" ? body.password : "";
        const key = `${clientKey(req, server)}|${email}`;
        if (loginLimit.blocked(key)) return fail(429, "too many failed attempts; try again in a few minutes");
        const row = db.query("SELECT id, password_hash FROM users WHERE email = ?").get(email) as { id: number; password_hash: string } | null;
        const ok = await Bun.password.verify(password.slice(0, MAX_PASSWORD), row?.password_hash ?? dummyHash);
        if (!row || !ok) {
            loginLimit.hit(key);
            return fail(401, "wrong email or password");
        }
        loginLimit.clear(key);
        recordUsage(db, row.id, "login");
        return json({ ok: true }, 200, { "set-cookie": startSession(row.id) });
    }

    function logout(req: Request): Response {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const token = readToken(req);
        if (token) db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
        return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
    }

    function me(req: Request): Response {
        const user = requireUser(req);
        if (user instanceof Response) return user;
        return json({ user: publicUser(user), motd: getSetting(db, "motd") ?? "" });
    }

    async function putMotd(req: Request): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const user = requireUser(req);
        if (user instanceof Response) return user;
        if (!user.isAdmin) return fail(403, "admins only");
        const body = await readObject(req);
        if (body instanceof Response) return body;
        if (typeof body.motd !== "string" || body.motd.length > MAX_MOTD) return fail(400, `the message must be text of at most ${MAX_MOTD} characters`);
        setSetting(db, "motd", body.motd.trim());
        return json({ motd: body.motd.trim() });
    }

    const routes = {
        "/api/auth/register": { POST: register },
        "/api/auth/login": { POST: login },
        "/api/auth/logout": { POST: logout },
        "/api/me": { GET: me },
        "/api/motd": { PUT: putMotd },
    };

    return { routes, userFrom, requireUser, requireGrader, canGrade, stop: () => clearInterval(timer) };
}

export type Auth = ReturnType<typeof createAuth>;
