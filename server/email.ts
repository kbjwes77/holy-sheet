// Transactional email: the welcome message and password-reset links, sent through Resend's HTTPS API (DigitalOcean
// blocks outbound SMTP). Without RESEND_EMAIL_API_KEY, messages are printed to the console instead, so the flows work
// locally. Sending never throws: a failed email is logged and the request that triggered it carries on.
import { Resend } from "resend";

export interface EmailOptions {
    /** Resend API key; unset means messages go to the console. */
    apiKey?: string;
    /** The From header, on a domain verified in Resend, e.g. `Grade Lake <noreply@mail.gradelake.com>`. */
    from?: string;
    /** Public base URL for links in emails. Required in production: the request's Host header can't be trusted there. */
    publicUrl?: string;
    /** Replaces Resend, for tests. */
    transport?: (message: EmailMessage) => Promise<void>;
}

export interface EmailMessage {
    to: string;
    subject: string;
    html: string;
    text: string;
    /** Resend drops a repeat send with the same key within 24 hours. */
    idempotencyKey?: string;
}

/** Resend's shared test sender: needs no verified domain, but only delivers to the Resend account's own address. */
export const RESEND_TEST_FROM = "Grade Lake <onboarding@resend.dev>";

/**
 * Email options from the environment. In production a Resend key also needs EMAIL_FROM and APP_BASE_URL, or the server
 * refuses to start; in development they default to Resend's test sender and the request's origin.
 */
export function emailOptionsFromEnv(env: Record<string, string | undefined>): EmailOptions {
    const get = (k: string) => env[k]?.trim() || undefined;
    const apiKey = get("RESEND_EMAIL_API_KEY");
    const publicUrl = get("APP_BASE_URL");
    let from = get("EMAIL_FROM");
    if (apiKey && env.NODE_ENV === "production") {
        if (!from) throw new Error("RESEND_EMAIL_API_KEY is set; also set EMAIL_FROM (e.g. Grade Lake <noreply@mail.gradelake.com>)");
        if (!publicUrl) throw new Error("RESEND_EMAIL_API_KEY is set; also set APP_BASE_URL so links in emails point at this site");
    }
    if (apiKey) from ??= RESEND_TEST_FROM;
    return { apiKey, from, publicUrl };
}

export function createMailer(o: EmailOptions = {}) {
    const resend = o.apiKey ? new Resend(o.apiKey) : null;
    const transport =
        o.transport ??
        (resend
            ? async (m: EmailMessage) => {
                  const { error } = await resend.emails.send({ from: o.from!, to: m.to, subject: m.subject, html: m.html, text: m.text }, m.idempotencyKey ? { idempotencyKey: m.idempotencyKey } : undefined);
                  if (error) throw new Error(`${error.name}: ${error.message}`);
              }
            : async (m: EmailMessage) => {
                  if (process.env.NODE_ENV !== "test") console.log(`[email] to ${m.to}: ${m.subject}\n${m.text}\n`);
              });

    /** Base URL for links: the configured one, or (development only) the request's origin. */
    const baseUrl = (req: Request) => (o.publicUrl ?? new URL(req.url).origin).replace(/\/$/, "");

    async function send(m: EmailMessage): Promise<boolean> {
        try {
            await transport(m);
            return true;
        } catch (e) {
            console.error(`email "${m.subject}" to ${m.to} failed: ${(e as Error).message}`);
            return false;
        }
    }

    return {
        baseUrl,
        send,
        welcome: (to: string, name: string, base: string, userId: number) => send({ to, ...welcomeEmail(name, base), idempotencyKey: `welcome-${userId}` }),
        passwordReset: (to: string, name: string, link: string) => send({ to, ...passwordResetEmail(name, link) }),
    };
}

export type Mailer = ReturnType<typeof createMailer>;

// --- Templates. Plain inline-styled HTML (mail clients ignore <style> and external CSS) with a text alternative.

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(body: string): string {
    return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2933">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:8px;padding:32px">
<p style="margin:0 0 24px;font-size:20px;font-weight:700">Grade Lake</p>
${body}
</div></body></html>`;
}

function button(href: string, label: string): string {
    return `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="display:inline-block;background:#1769aa;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600">${escapeHtml(label)}</a></p>`;
}

export function welcomeEmail(name: string, base: string) {
    const link = `${base}/dashboard`;
    return {
        subject: "Welcome to Grade Lake",
        html: layout(`<p>Hi ${escapeHtml(name)},</p>
<p>Thanks for signing up. You can build printable answer sheets, keep your quizzes and slides in your library, and grade scanned exams.</p>
${button(link, "Go to your dashboard")}
<p style="color:#616e7c;font-size:14px">If you didn't create this account, you can ignore this email.</p>`),
        text: `Hi ${name},\n\nThanks for signing up for Grade Lake. You can build printable answer sheets, keep your quizzes and slides in your library, and grade scanned exams.\n\nGo to your dashboard: ${link}\n\nIf you didn't create this account, you can ignore this email.`,
    };
}

export function passwordResetEmail(name: string, link: string) {
    return {
        subject: "Reset your Grade Lake password",
        html: layout(`<p>Hi ${escapeHtml(name)},</p>
<p>Someone asked to reset the password for your Grade Lake account. The link works once, for one hour.</p>
${button(link, "Choose a new password")}
<p style="color:#616e7c;font-size:14px">If it wasn't you, ignore this email; your password stays the same.</p>`),
        text: `Hi ${name},\n\nSomeone asked to reset the password for your Grade Lake account. This link works once, for one hour:\n\n${link}\n\nIf it wasn't you, ignore this email; your password stays the same.`,
    };
}
