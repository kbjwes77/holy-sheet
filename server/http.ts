// Small HTTP helpers shared by the API modules.

export const json = (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, { status, headers });
export const fail = (status: number, error: string) => json({ error }, status);

/**
 * POSTs from other sites (a page can post to this server) are refused. Compares hosts rather than
 * full origins: behind a TLS-terminating proxy the request URL says http while the browser says https.
 */
export function sameOrigin(req: Request): boolean {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    try {
        return new URL(origin).host === (req.headers.get("host") ?? new URL(req.url).host);
    } catch {
        return false;
    }
}

/** The request's JSON object body, or a 400 response. */
export async function readObject(req: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown> | Response> {
    const text = await req.text();
    if (text.length > maxBytes) return fail(413, "the request is too large");
    try {
        const v: unknown = JSON.parse(text);
        if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
        // falls through
    }
    return fail(400, "expected a JSON object");
}
