// The signed-in user's own account: display name, password, email address and deleting the account. Changing the
// password, the email or deleting asks for the current password. A new email address takes effect only once it is
// confirmed through a one-hour, single-use link sent to it (stored hashed, like reset links), and the old address
// is told about the request.
import type { Database } from "bun:sqlite";
import { EMAIL_RE, MAX_PASSWORD, MIN_PASSWORD, RateLimit, sha256, type Auth } from "./auth.ts";
import { now } from "./db.ts";
import type { Mailer } from "./email.ts";
import { fail, json, readObject, sameOrigin } from "./http.ts";

export const EMAIL_CHANGE_TTL = 60 * 60;
export const MAX_DISPLAY_NAME = 60;

export interface AccountDeps {
    auth: Auth;
    mailer: Mailer;
    /** Ends the user's Stripe billing; null when done, else why it couldn't be (then the account is kept). */
    deleteCustomer: (userId: number) => Promise<string | null>;
    /** Stops the user's unfinished grading jobs. */
    cancelJobs: (userId: number) => void;
}

export function createAccount(db: Database, { auth, mailer, deleteCustomer, cancelJobs }: AccountDeps) {
    // Wrong current passwords, per account, so a stolen session can't be used to guess the password.
    const passwordLimit = new RateLimit(5, 15 * 60_000);
    // Change-of-address emails, per account.
    const emailLimit = new RateLimit(3, 60 * 60_000);

    /** null if `password` is the user's current password, else the response to send. */
    async function checkPassword(userId: number, password: unknown): Promise<Response | null> {
        const key = String(userId);
        if (passwordLimit.blocked(key)) return fail(429, "too many wrong passwords; try again in a few minutes");
        const row = db.query("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string } | null;
        const ok = typeof password === "string" && password.length <= MAX_PASSWORD && !!row && (await Bun.password.verify(password, row.password_hash));
        if (!ok) {
            passwordLimit.hit(key);
            // Not 401: the page would take that as signed out.
            return fail(403, "your current password is wrong");
        }
        passwordLimit.clear(key);
        return null;
    }

    const pendingEmail = (userId: number) =>
        (db.query("SELECT new_email FROM email_changes WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1").get(userId, now()) as { new_email: string } | null)?.new_email ?? null;

    function info(req: Request): Response {
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        return json({ pendingEmail: pendingEmail(me.id) });
    }

    async function updateName(req: Request): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const body = await readObject(req);
        if (body instanceof Response) return body;
        const name = typeof body.displayName === "string" ? body.displayName.trim() : "";
        if (!name || name.length > MAX_DISPLAY_NAME) return fail(400, `the display name must be 1–${MAX_DISPLAY_NAME} characters`);
        db.query("UPDATE users SET display_name = ? WHERE id = ?").run(name, me.id);
        return json({ user: auth.publicUser(auth.userFrom(req)!) });
    }

    /** Sets a new password; this browser stays signed in and every other session ends. */
    async function changePassword(req: Request): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const body = await readObject(req);
        if (body instanceof Response) return body;
        const password = typeof body.password === "string" ? body.password : "";
        if (password.length < MIN_PASSWORD) return fail(400, `the new password must be at least ${MIN_PASSWORD} characters`);
        if (password.length > MAX_PASSWORD) return fail(400, `the new password must be at most ${MAX_PASSWORD} characters`);
        const wrong = await checkPassword(me.id, body.current);
        if (wrong) return wrong;
        const hash = await Bun.password.hash(password);
        const keep = auth.sessionHash(req);
        db.transaction(() => {
            db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, me.id);
            db.query("DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?").run(me.id, keep);
            db.query("DELETE FROM password_resets WHERE user_id = ?").run(me.id);
            db.query("DELETE FROM email_changes WHERE user_id = ?").run(me.id);
        })();
        return json({ ok: true });
    }

    /** Emails a confirmation link to the new address and a notice to the current one; nothing changes until it is confirmed. */
    async function requestEmail(req: Request): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const body = await readObject(req);
        if (body instanceof Response) return body;
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!EMAIL_RE.test(email) || email.length > 254) return fail(400, "enter a valid email address");
        if (email === me.email) return fail(400, "that's already your email address");
        if (db.query("SELECT 1 FROM users WHERE email = ?").get(email)) return fail(409, "an account with that email already exists");
        const key = String(me.id);
        if (emailLimit.blocked(key)) return fail(429, "too many email changes; try again later");
        const wrong = await checkPassword(me.id, body.password);
        if (wrong) return wrong;
        emailLimit.hit(key);
        const token = auth.newToken();
        const t = now();
        // Only the newest request works.
        db.transaction(() => {
            db.query("DELETE FROM email_changes WHERE user_id = ?").run(me.id);
            db.query("INSERT INTO email_changes (token_hash, user_id, new_email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(sha256(token), me.id, email, t, t + EMAIL_CHANGE_TTL);
        })();
        const base = mailer.baseUrl(req);
        // In the fragment, like reset links, so the token stays out of logs and Referer headers.
        void mailer.emailChange(email, me.displayName, `${base}/confirm-email#token=${token}`);
        void mailer.emailChangeNotice(me.email, me.displayName, email, base);
        return json({ pendingEmail: email });
    }

    function cancelEmail(req: Request): Response {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        db.query("DELETE FROM email_changes WHERE user_id = ?").run(me.id);
        return json({ pendingEmail: null });
    }

    /** Applies an email change from its link. Needs no session: the link may be opened on another device. */
    async function confirmEmail(req: Request): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const body = await readObject(req);
        if (body instanceof Response) return body;
        const token = typeof body.token === "string" ? body.token : "";
        const result = db.transaction((): { email: string } | "invalid" | "taken" => {
            const row = db.query("DELETE FROM email_changes WHERE token_hash = ? AND expires_at > ? RETURNING user_id, new_email").get(sha256(token), now()) as { user_id: number; new_email: string } | null;
            if (!row) return "invalid";
            if (db.query("SELECT 1 FROM users WHERE email = ?").get(row.new_email)) return "taken";
            db.query("UPDATE users SET email = ? WHERE id = ?").run(row.new_email, row.user_id);
            db.query("DELETE FROM email_changes WHERE user_id = ?").run(row.user_id);
            return { email: row.new_email };
        })();
        if (result === "invalid") return fail(400, "this confirmation link is invalid or has expired; change your email again from your account page");
        if (result === "taken") return fail(409, "another account started using that email address in the meantime");
        return json({ email: result.email });
    }

    /**
     * Deletes the account and everything tied to it (library, groups, saved results, usage, sessions), after ending
     * any Stripe subscription and stopping the user's grading jobs. Materials others copied are their own and stay.
     */
    async function deleteAccount(req: Request): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const body = await readObject(req);
        if (body instanceof Response) return body;
        const wrong = await checkPassword(me.id, body.password);
        if (wrong) return wrong;
        cancelJobs(me.id);
        const billing = await deleteCustomer(me.id);
        if (billing) return fail(502, `${billing}. Your account hasn't been deleted.`);
        db.query("DELETE FROM users WHERE id = ?").run(me.id);
        console.log(`account ${me.id} deleted by its owner`);
        void mailer.accountDeleted(me.email, me.displayName);
        return json({ ok: true }, 200, { "set-cookie": auth.clearCookie() });
    }

    const routes = {
        "/api/account": { GET: info, PATCH: updateName },
        "/api/account/password": { POST: changePassword },
        "/api/account/email": { POST: requestEmail, DELETE: cancelEmail },
        "/api/account/email/confirm": { POST: confirmEmail },
        "/api/account/delete": { POST: deleteAccount },
    };
    return { routes };
}
