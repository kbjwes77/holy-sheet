// Student-name OCR behind an interface, with an OpenRouter vision-model implementation.

export interface NameReader {
    /** Returns the handwritten name in the PNG crop of the Name box. */
    readName(png: Uint8Array, file: string): Promise<string>;
}

export class OcrError extends Error {
    override name = "OcrError";
}

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const PROMPT =
    "This image is the 'Name (first and last)' box from a student's test sheet. Read the handwritten " +
    'student name exactly as written. Reply with only strict JSON: {"name": "<first and last name>"}. ' +
    'If the box is blank or illegible, reply {"name": ""}.';

/** Extracts `{name}` from a model reply, tolerating code fences around the JSON. */
export function parseNameReply(content: string): string {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new OcrError(`model reply is not JSON: ${content.slice(0, 120)}`);
    let parsed: unknown;
    try {
        parsed = JSON.parse(m[0]);
    } catch {
        throw new OcrError(`model reply is not valid JSON: ${m[0].slice(0, 120)}`);
    }
    const name = (parsed as { name?: unknown }).name;
    if (typeof name !== "string") throw new OcrError("model reply has no name string");
    return name.replace(/\s+/g, " ").trim();
}

class TransientError extends Error {}

export interface OpenRouterOptions {
    apiKey: string;
    model: string;
    fetch?: typeof fetch;
    retries?: number;
    /** Base backoff in ms; doubles per attempt. */
    backoffMs?: number;
}

export class OpenRouterNameReader implements NameReader {
    constructor(private readonly o: OpenRouterOptions) {}

    async readName(png: Uint8Array): Promise<string> {
        const retries = this.o.retries ?? 3;
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.once(png);
            } catch (e) {
                if (!(e instanceof TransientError) || attempt >= retries) {
                    throw e instanceof OcrError ? e : new OcrError((e as Error).message);
                }
                await Bun.sleep((this.o.backoffMs ?? 1000) * 2 ** attempt);
            }
        }
    }

    private async once(png: Uint8Array): Promise<string> {
        const f = this.o.fetch ?? fetch;
        let res: Response;
        try {
            res = await f(OPENROUTER_URL, {
                method: "POST",
                headers: { Authorization: `Bearer ${this.o.apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: this.o.model,
                    temperature: 0,
                    response_format: { type: "json_object" },
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: PROMPT },
                                { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` } },
                            ],
                        },
                    ],
                }),
            });
        } catch (e) {
            throw new TransientError(`request failed: ${(e as Error).message}`);
        }
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) throw new TransientError(`OpenRouter HTTP ${res.status}: ${text.slice(0, 200)}`);
        if (!res.ok) throw new OcrError(`OpenRouter HTTP ${res.status}: ${text.slice(0, 200)}`);
        let body: { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } };
        try {
            body = JSON.parse(text);
        } catch {
            throw new TransientError(`OpenRouter returned non-JSON: ${text.slice(0, 120)}`);
        }
        if (body.error) throw new OcrError(`OpenRouter error: ${body.error.message ?? "unknown"}`);
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new OcrError("OpenRouter reply has no message content");
        return parseNameReply(content);
    }
}

/** Runs at most `limit` calls of `fn` at once. */
export function limitConcurrency<A extends unknown[], R>(limit: number, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    let active = 0;
    const queue: (() => void)[] = [];
    return async (...args: A) => {
        // A finishing call hands its slot straight to the next waiter, so `active` never dips
        // below the limit while callers are queued.
        if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
        else active++;
        try {
            return await fn(...args);
        } finally {
            const next = queue.shift();
            if (next) next();
            else active--;
        }
    };
}
