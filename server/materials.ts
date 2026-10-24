// The study-material library: materials (a test's JSON, typed, named and tagged) and the
// groups that organize them. Every write belongs to the signed-in author; other users can see
// and download only what is published.
import type { Database } from "bun:sqlite";
import { unzipSync } from "fflate";
import { parseSheetJson } from "../gen/testdef.ts";
import type { Auth, User } from "./auth.ts";
import { MATERIAL_TYPES, now, recordUsage, STATUSES, type MaterialType, type Status } from "./db.ts";
import { fail, json, readObject, sameOrigin } from "./http.ts";

export const MAX_NAME = 200;
export const MAX_TAGS = 10;
export const MAX_TAG = 30;
export const MAX_DESCRIPTION = 1000;
const MAX_CONTENT = 8 * 1024 * 1024;
/** Uploaded decks: large enough for ordinary image-rich presentations, small enough for SQLite. */
export const MAX_DECK_BYTES = 25 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const DECK_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PAGE = 50;
const MAX_DEPTH = 20;

interface MaterialRow {
    id: number;
    owner_id: number;
    owner_name: string;
    group_id: number | null;
    type: MaterialType;
    name: string;
    status: Status;
    created_at: number;
    updated_at: number;
    file_name?: string | null;
    file_size?: number;
    file?: Uint8Array | null;
    content?: string;
}

interface GroupRow {
    id: number;
    owner_id: number;
    parent_id: number | null;
    name: string;
    description: string;
    status: Status;
    created_at: number;
    updated_at: number;
}

/** Lower-cased, trimmed, de-duplicated tags, or an error message. */
export function parseTags(v: unknown): string[] | string {
    if (v === undefined) return [];
    if (!Array.isArray(v)) return "tags must be a list of text";
    const tags = new Set<string>();
    for (const t of v) {
        if (typeof t !== "string") return "tags must be a list of text";
        const tag = t.trim().toLowerCase().replace(/\s+/g, " ");
        if (!tag) continue;
        if (tag.length > MAX_TAG) return `a tag can be at most ${MAX_TAG} characters`;
        tags.add(tag);
    }
    if (tags.size > MAX_TAGS) return `at most ${MAX_TAGS} tags`;
    return [...tags];
}

const isType = (v: unknown): v is MaterialType => (MATERIAL_TYPES as readonly unknown[]).includes(v);
const isStatus = (v: unknown): v is Status => (STATUSES as readonly unknown[]).includes(v);
const parseName = (v: unknown): string | null => (typeof v === "string" && v.trim() && v.trim().length <= MAX_NAME ? v.trim() : null);

export function createMaterialsApi(db: Database, auth: Auth) {
    const tagsOf = (ids: number[]): Map<number, string[]> => {
        const map = new Map<number, string[]>();
        if (!ids.length) return map;
        const rows = db.query(`SELECT material_id, tag FROM material_tags WHERE material_id IN (${ids.map(() => "?").join(",")}) ORDER BY tag`).all(...ids) as { material_id: number; tag: string }[];
        for (const r of rows) map.set(r.material_id, [...(map.get(r.material_id) ?? []), r.tag]);
        return map;
    };

    const present = (rows: MaterialRow[], me: User) => {
        const tags = tagsOf(rows.map((r) => r.id));
        return rows.map((r) => ({
            id: r.id,
            type: r.type,
            name: r.name,
            tags: tags.get(r.id) ?? [],
            status: r.status,
            groupId: r.group_id,
            author: r.owner_name,
            mine: r.owner_id === me.id,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            ...(r.type === "Slides"
                ? { fileName: r.file_name ?? null, fileSize: r.file_size ?? 0 }
                : {}),
            ...(r.content === undefined || r.type === "Slides" ? {} : { content: r.content }),
        }));
    };

    const SELECT = "SELECT m.id, m.owner_id, u.display_name AS owner_name, m.group_id, m.type, m.name, m.status, m.created_at, m.updated_at, m.file_name, m.file_size";

    const getMaterial = (id: number, withContent: boolean, withFile = withContent): MaterialRow | null =>
        db.query(`${SELECT}${withContent ? ", m.content" : ""}${withFile ? ", m.file" : ""} FROM study_materials m JOIN users u ON u.id = m.owner_id WHERE m.id = ?`).get(id) as MaterialRow | null;

    /** A material the user may see: their own, or anyone's published one. */
    const visible = (m: MaterialRow | null, me: User): m is MaterialRow => !!m && (m.owner_id === me.id || m.status === "published");

    const getGroup = (id: number): GroupRow | null => db.query("SELECT * FROM material_groups WHERE id = ?").get(id) as GroupRow | null;

    const presentGroup = (g: GroupRow) => ({ id: g.id, parentId: g.parent_id, name: g.name, description: g.description, status: g.status, createdAt: g.created_at, updatedAt: g.updated_at });

    function setTags(id: number, tags: string[]): void {
        db.query("DELETE FROM material_tags WHERE material_id = ?").run(id);
        for (const t of tags) db.query("INSERT INTO material_tags (material_id, tag) VALUES (?, ?)").run(id, t);
    }

    /** Checks `groupId` is one of the user's groups (or null for the root). */
    function checkGroup(groupId: unknown, me: User): number | null | Response {
        if (groupId === null || groupId === undefined) return null;
        if (typeof groupId !== "number" || !Number.isInteger(groupId)) return fail(400, "groupId must be a group's id or null");
        const g = getGroup(groupId);
        if (!g || g.owner_id !== me.id) return fail(404, "no such group");
        return g.id;
    }

    /** Validates a test's JSON the way the generator and grader do. */
    function checkContent(content: unknown): string | Response {
        if (typeof content !== "string" || !content.trim()) return fail(400, "content must be the test's JSON text");
        if (content.length > MAX_CONTENT) return fail(413, "the test JSON is too large");
        const parsed = parseSheetJson(content, { layout: false });
        if (!parsed.ok) {
            const first = parsed.errors[0]!;
            return fail(400, `the test JSON is invalid: ${first.where}: ${first.message}`);
        }
        return content;
    }

    /** A .pptx upload, or a message explaining why it was rejected. */
    interface DeckUpload {
        bytes: Uint8Array;
        fileName: string;
    }

    /**
     * Cheap structural check: the file must be a ZIP whose central directory names the two parts
     * every PresentationML package needs. Nothing is decompressed: the sizes in a zip's central
     * directory are uploader-controlled, so trusting them (or inflating the entries at all) lets a
     * tiny file stall the server while expanding to gigabytes.
     */
    function checkDeck(fileName: string, bytes: Uint8Array): DeckUpload | string {
        if (!fileName.toLowerCase().endsWith(".pptx")) return "only .pptx files are accepted";
        if (!bytes.length) return "the file is empty";
        if (bytes.length > MAX_DECK_BYTES) return `the deck is too large (max ${MAX_DECK_BYTES / 1024 / 1024} MB)`;
        const wanted = new Set(["[Content_Types].xml", "ppt/presentation.xml"]);
        const found = new Set<string>();
        let entries = 0;
        try {
            unzipSync(bytes, {
                filter: (f) => {
                    if (++entries > MAX_ZIP_ENTRIES) throw new Error("too many zip entries");
                    if (wanted.has(f.name)) found.add(f.name);
                    return false;
                },
            });
        } catch {
            return "the file is not a readable .pptx presentation";
        }
        if (!found.has("[Content_Types].xml") || !found.has("ppt/presentation.xml")) {
            return "the file is not a PowerPoint .pptx presentation";
        }
        return { bytes, fileName };
    }

    const MAX_UPLOAD_BYTES = MAX_DECK_BYTES + 256 * 1024;
    const TOO_LARGE = `the deck is too large (max ${MAX_DECK_BYTES / 1024 / 1024} MB)`;

    /** Reads a request body, refusing more than `max` bytes even when no Content-Length is sent. */
    async function readBounded(req: Request, max: number): Promise<Uint8Array | Response> {
        const declared = Number(req.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > max) return fail(413, TOO_LARGE);
        if (!req.body) return fail(400, "expected a request body");
        const reader = req.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > max) {
                    await reader.cancel().catch(() => {});
                    return fail(413, TOO_LARGE);
                }
                chunks.push(value);
            }
        } catch {
            return fail(400, "the upload was interrupted");
        }
        const body = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
            body.set(chunk, at);
            at += chunk.byteLength;
        }
        return body;
    }

    /** A bounded multipart form, or the response explaining why it was refused. */
    async function readDeckForm(req: Request): Promise<FormData | Response> {
        const body = await readBounded(req, MAX_UPLOAD_BYTES);
        if (body instanceof Response) return body;
        try {
            return await new Response(body as unknown as BodyInit, {
                headers: { "content-type": req.headers.get("content-type") ?? "" },
            }).formData();
        } catch {
            return fail(400, "expected a multipart form with a .pptx file");
        }
    }

    function formTags(form: FormData): string[] | string {
        const raw = form.get("tags");
        if (typeof raw !== "string" || !raw.trim()) return [];
        try {
            return parseTags(JSON.parse(raw));
        } catch {
            return "tags must be a list of text";
        }
    }

    function formGroupId(form: FormData): unknown {
        const raw = form.get("groupId");
        if (raw === null || raw === "") return null;
        return typeof raw === "string" ? Number(raw) : raw;
    }

    function deckResponse(m: MaterialRow, inline: boolean): Response {
        if (!m.file) return fail(404, "no file for this material");
        // Downloads follow the material's name (like JSON materials); inline viewing keeps the upload's name.
        const suggested = inline ? (m.file_name ?? `${m.name}.pptx`) : `${m.name}.pptx`;
        const base = suggested.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 80).trim() || "deck.pptx";
        const file = base.toLowerCase().endsWith(".pptx") ? base : `${base}.pptx`;
        return new Response(m.file as unknown as BodyInit, {
            headers: {
                "content-type": DECK_TYPE,
                "content-disposition": `${inline ? "inline" : "attachment"}; filename="${file}"`,
                "cache-control": "private, no-store",
                "x-content-type-options": "nosniff",
            },
        });
    }

    // ---- Materials ----------------------------------------------------------

    /** Lists materials: `scope=mine` (default) or `scope=community` (published, anyone's), filtered by type, name, tag, group. */
    function listMaterials(req: Request): Response {
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const q = new URL(req.url).searchParams;
        const community = q.get("scope") === "community";
        const where: string[] = [];
        const args: (string | number)[] = [];
        if (community) where.push("m.status = 'published'");
        else {
            where.push("m.owner_id = ?");
            args.push(me.id);
        }
        // `?type=Quiz&type=Exam` asks for either; a single `type` works as before.
        const types = [...new Set(q.getAll("type").filter((t) => t !== ""))];
        if (types.length) {
            for (const t of types) if (!isType(t)) return fail(400, "unknown type");
            where.push(`m.type IN (${types.map(() => "?").join(", ")})`);
            args.push(...types);
        }
        const status = q.get("status");
        if (status) {
            if (!isStatus(status) || community) return fail(400, "unknown status");
            where.push("m.status = ?");
            args.push(status);
        }
        const name = q.get("q")?.trim();
        if (name) {
            where.push("m.name LIKE ? ESCAPE '\\'");
            args.push(`%${name.replace(/[\\%_]/g, "\\$&")}%`);
        }
        // Every requested tag must be present (?tag=a&tag=b).
        for (const raw of q.getAll("tag")) {
            const tag = raw.trim().toLowerCase();
            if (!tag) continue;
            where.push("EXISTS (SELECT 1 FROM material_tags t WHERE t.material_id = m.id AND t.tag = ?)");
            args.push(tag);
        }
        if (!community && q.has("group")) {
            const g = q.get("group");
            if (g === "root") where.push("m.group_id IS NULL");
            else {
                const id = Number(g);
                if (!Number.isInteger(id)) return fail(400, "bad group");
                where.push("m.group_id = ?");
                args.push(id);
            }
        }
        const limit = Math.min(Math.max(Number(q.get("limit")) || PAGE, 1), 200);
        const offset = Math.max(Number(q.get("offset")) || 0, 0);
        const from = `FROM study_materials m JOIN users u ON u.id = m.owner_id WHERE ${where.join(" AND ")}`;
        const total = (db.query(`SELECT COUNT(*) AS n ${from}`).get(...args) as { n: number }).n;
        const rows = db.query(`${SELECT} ${from} ORDER BY m.updated_at DESC, m.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as MaterialRow[];
        return json({ total, materials: present(rows, me) });
    }

    function getOne(req: Request, id: number): Response {
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        // Metadata only: a slide deck's bytes are fetched separately by the viewer.
        const m = getMaterial(id, true, false);
        if (!visible(m, me)) return fail(404, "no such material");
        return json(present([m], me)[0]);
    }

    /** Creates a Slides material from a multipart form carrying the .pptx file and its metadata. */
    async function createDeck(req: Request, me: User): Promise<Response> {
        const parsed = await readDeckForm(req);
        if (parsed instanceof Response) return parsed;
        const form = parsed;
        const file = form.get("file");
        if (!(file instanceof Blob)) return fail(400, "attach a .pptx file");
        if (file.size > MAX_DECK_BYTES) return fail(413, `the deck is too large (max ${MAX_DECK_BYTES / 1024 / 1024} MB)`);
        const name = parseName(form.get("name"));
        if (!name) return fail(400, `the name must be 1–${MAX_NAME} characters`);
        const status = form.get("status") ?? "draft";
        if (typeof status !== "string" || !isStatus(status)) return fail(400, `status must be one of ${STATUSES.join(", ")}`);
        const tags = formTags(form);
        if (typeof tags === "string") return fail(400, tags);
        const group = checkGroup(formGroupId(form), me);
        if (group instanceof Response) return group;
        const fileName = typeof (file as File).name === "string" && (file as File).name ? (file as File).name : "deck.pptx";
        const deck = checkDeck(fileName, new Uint8Array(await file.arrayBuffer()));
        if (typeof deck === "string") return fail(400, deck);
        const t = now();
        const id = db.transaction(() => {
            const newId = Number(
                db
                    .query("INSERT INTO study_materials (owner_id, group_id, type, name, content, file, file_name, file_size, status, created_at, updated_at) VALUES (?, ?, 'Slides', ?, '', ?, ?, ?, ?, ?, ?)")
                    .run(me.id, group, name, deck.bytes, deck.fileName, deck.bytes.length, status, t, t).lastInsertRowid,
            );
            setTags(newId, tags);
            return newId;
        })();
        recordUsage(db, me.id, "material_created", 1, { id, type: "Slides" });
        return json(present([getMaterial(id, false)!], me)[0], 201);
    }

    async function create(req: Request): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        if ((req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return createDeck(req, me);
        const body = await readObject(req, MAX_CONTENT + 4096);
        if (body instanceof Response) return body;
        const name = parseName(body.name);
        if (!name) return fail(400, `the name must be 1–${MAX_NAME} characters`);
        if (!isType(body.type)) return fail(400, `type must be one of ${MATERIAL_TYPES.join(", ")}`);
        if (body.type === "Slides") return fail(400, "upload slide decks as a .pptx file");
        const status = body.status === undefined ? "draft" : body.status;
        if (!isStatus(status)) return fail(400, `status must be one of ${STATUSES.join(", ")}`);
        const tags = parseTags(body.tags);
        if (typeof tags === "string") return fail(400, tags);
        const group = checkGroup(body.groupId, me);
        if (group instanceof Response) return group;
        const content = checkContent(body.content);
        if (content instanceof Response) return content;
        const t = now();
        const id = db.transaction(() => {
            const newId = Number(db.query("INSERT INTO study_materials (owner_id, group_id, type, name, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(me.id, group, body.type as string, name, content, status, t, t).lastInsertRowid);
            setTags(newId, tags);
            return newId;
        })();
        recordUsage(db, me.id, "material_created", 1, { id, type: body.type });
        return json(present([getMaterial(id, true)!], me)[0], 201);
    }

    async function update(req: Request, id: number): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const m = getMaterial(id, false);
        if (!m || m.owner_id !== me.id) return fail(404, "no such material");
        // A deck can be re-uploaded and re-labelled in one request.
        if ((req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
            if (m.type !== "Slides") return fail(400, "only slide decks are uploaded as files");
            return updateDeck(req, me, m);
        }
        const body = await readObject(req, MAX_CONTENT + 4096);
        if (body instanceof Response) return body;
        const sets: string[] = [];
        const args: (string | number | null)[] = [];
        if (body.name !== undefined) {
            const name = parseName(body.name);
            if (!name) return fail(400, `the name must be 1–${MAX_NAME} characters`);
            sets.push("name = ?");
            args.push(name);
        }
        if (body.type !== undefined) {
            if (!isType(body.type)) return fail(400, `type must be one of ${MATERIAL_TYPES.join(", ")}`);
            // A deck's bytes and a test's JSON are not interchangeable; conversions need a new upload.
            if (m.type === "Slides" || body.type === "Slides") return fail(400, "a slide deck's type can't be changed");
            sets.push("type = ?");
            args.push(body.type);
        }
        if (body.status !== undefined) {
            if (!isStatus(body.status)) return fail(400, `status must be one of ${STATUSES.join(", ")}`);
            sets.push("status = ?");
            args.push(body.status);
        }
        if (body.groupId !== undefined) {
            const group = checkGroup(body.groupId, me);
            if (group instanceof Response) return group;
            sets.push("group_id = ?");
            args.push(group);
        }
        if (body.content !== undefined) {
            if (m.type === "Slides") return fail(400, "slide decks are replaced by uploading a .pptx file, not with JSON content");
            const content = checkContent(body.content);
            if (content instanceof Response) return content;
            sets.push("content = ?");
            args.push(content);
        }
        let tags: string[] | undefined;
        if (body.tags !== undefined) {
            const parsed = parseTags(body.tags);
            if (typeof parsed === "string") return fail(400, parsed);
            tags = parsed;
        }
        db.transaction(() => {
            sets.push("updated_at = ?");
            args.push(now());
            db.query(`UPDATE study_materials SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
            if (tags) setTags(id, tags);
        })();
        return json(present([getMaterial(id, true, m.type !== "Slides")!], me)[0]);
    }

    function remove(req: Request, id: number): Response {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const m = getMaterial(id, false);
        if (!m || m.owner_id !== me.id) return fail(404, "no such material");
        db.query("DELETE FROM study_materials WHERE id = ?").run(id);
        return new Response(null, { status: 204 });
    }

    /** The original file: test JSON, or a deck's .pptx. */
    function download(req: Request, id: number): Response {
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const m = getMaterial(id, true);
        if (!visible(m, me)) return fail(404, "no such material");
        if (m.owner_id !== me.id) recordUsage(db, me.id, "material_downloaded", 1, { id });
        if (m.type === "Slides") return deckResponse(m, false);
        const file = `${m.name.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 80).trim() || "material"}.json`;
        return new Response(m.content, { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${file}"`, "cache-control": "no-store" } });
    }

    /** The deck bytes for the in-browser viewer (inline, never an attachment). */
    function fileContent(req: Request, id: number): Response {
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const m = getMaterial(id, true);
        if (!visible(m, me) || m.type !== "Slides") return fail(404, "no such slide deck");
        return deckResponse(m, true);
    }

    /**
     * Applies a multipart update to a deck: the .pptx and any metadata fields in one transaction,
     * so a failed upload can't leave a published name update behind.
     */
    async function updateDeck(req: Request, me: User, m: MaterialRow): Promise<Response> {
        const parsed = await readDeckForm(req);
        if (parsed instanceof Response) return parsed;
        const form = parsed;
        const file = form.get("file");
        if (!(file instanceof Blob)) return fail(400, "attach a .pptx file");
        if (file.size > MAX_DECK_BYTES) return fail(413, TOO_LARGE);
        const fileName = typeof (file as File).name === "string" && (file as File).name ? (file as File).name : "deck.pptx";
        const deck = checkDeck(fileName, new Uint8Array(await file.arrayBuffer()));
        if (typeof deck === "string") return fail(400, deck);

        const sets = ["file = ?", "file_name = ?", "file_size = ?"];
        const args: (string | number | null | Uint8Array)[] = [deck.bytes, deck.fileName, deck.bytes.length];
        if (form.has("name")) {
            const name = parseName(form.get("name"));
            if (!name) return fail(400, `the name must be 1–${MAX_NAME} characters`);
            sets.push("name = ?");
            args.push(name);
        }
        if (form.has("status")) {
            const status = form.get("status");
            if (typeof status !== "string" || !isStatus(status)) return fail(400, `status must be one of ${STATUSES.join(", ")}`);
            sets.push("status = ?");
            args.push(status);
        }
        if (form.has("groupId")) {
            const group = checkGroup(formGroupId(form), me);
            if (group instanceof Response) return group;
            sets.push("group_id = ?");
            args.push(group);
        }
        let tags: string[] | undefined;
        if (form.has("tags")) {
            const parsedTags = formTags(form);
            if (typeof parsedTags === "string") return fail(400, parsedTags);
            tags = parsedTags;
        }
        db.transaction(() => {
            sets.push("updated_at = ?");
            args.push(now());
            db.query(`UPDATE study_materials SET ${sets.join(", ")} WHERE id = ?`).run(...args, m.id);
            if (tags) setTags(m.id, tags);
        })();
        return json(present([getMaterial(m.id, false)!], me)[0]);
    }

    /** Replaces the .pptx of an existing deck, optionally updating its metadata too. */
    async function replaceDeck(req: Request, id: number): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const m = getMaterial(id, false);
        if (!m || m.owner_id !== me.id || m.type !== "Slides") return fail(404, "no such slide deck");
        return updateDeck(req, me, m);
    }

    /** Copies a visible material into the user's own library as a draft. */
    function copy(req: Request, id: number): Response {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const m = getMaterial(id, true);
        if (!visible(m, me)) return fail(404, "no such material");
        const t = now();
        const newId = db.transaction(() => {
            const nid = Number(
                db
                    .query(
                        "INSERT INTO study_materials (owner_id, group_id, type, name, content, file, file_name, file_size, status, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
                    )
                    .run(me.id, m.type, m.name, m.content ?? "", m.file ?? null, m.file_name ?? null, m.file_size ?? 0, t, t).lastInsertRowid,
            );
            db.query("INSERT INTO material_tags (material_id, tag) SELECT ?, tag FROM material_tags WHERE material_id = ?").run(nid, id);
            return nid;
        })();
        if (m.owner_id !== me.id) recordUsage(db, me.id, "material_copied", 1, { id });
        return json(present([getMaterial(newId, true)!], me)[0], 201);
    }

    // ---- Groups -------------------------------------------------------------

    /** The user's own groups, flat (the page builds the tree from `parentId`). */
    function listGroups(req: Request): Response {
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const rows = db.query("SELECT * FROM material_groups WHERE owner_id = ? ORDER BY name COLLATE NOCASE, id").all(me.id) as GroupRow[];
        return json({ groups: rows.map(presentGroup) });
    }

    /** Whether making `parentId` the parent of `groupId` would form a cycle or nest too deep. */
    function badParent(groupId: number | null, parentId: number): boolean {
        let depth = 1;
        for (let cur: number | null = parentId; cur !== null; depth++) {
            if (cur === groupId || depth > MAX_DEPTH) return true;
            cur = (db.query("SELECT parent_id FROM material_groups WHERE id = ?").get(cur) as { parent_id: number | null } | null)?.parent_id ?? null;
        }
        return false;
    }

    async function createGroup(req: Request): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const body = await readObject(req);
        if (body instanceof Response) return body;
        const name = parseName(body.name);
        if (!name) return fail(400, `the name must be 1–${MAX_NAME} characters`);
        const description = body.description === undefined ? "" : body.description;
        if (typeof description !== "string" || description.length > MAX_DESCRIPTION) return fail(400, `the description must be at most ${MAX_DESCRIPTION} characters`);
        const status = body.status === undefined ? "draft" : body.status;
        if (!isStatus(status)) return fail(400, `status must be one of ${STATUSES.join(", ")}`);
        const parent = checkGroup(body.parentId, me);
        if (parent instanceof Response) return parent;
        if (parent !== null && badParent(null, parent)) return fail(400, "groups are nested too deeply");
        const t = now();
        const id = Number(db.query("INSERT INTO material_groups (owner_id, parent_id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(me.id, parent, name, description.trim(), status, t, t).lastInsertRowid);
        return json(presentGroup(getGroup(id)!), 201);
    }

    async function updateGroup(req: Request, id: number): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const g = getGroup(id);
        if (!g || g.owner_id !== me.id) return fail(404, "no such group");
        const body = await readObject(req);
        if (body instanceof Response) return body;
        const sets: string[] = [];
        const args: (string | number | null)[] = [];
        if (body.name !== undefined) {
            const name = parseName(body.name);
            if (!name) return fail(400, `the name must be 1–${MAX_NAME} characters`);
            sets.push("name = ?");
            args.push(name);
        }
        if (body.description !== undefined) {
            if (typeof body.description !== "string" || body.description.length > MAX_DESCRIPTION) return fail(400, `the description must be at most ${MAX_DESCRIPTION} characters`);
            sets.push("description = ?");
            args.push(body.description.trim());
        }
        if (body.status !== undefined) {
            if (!isStatus(body.status)) return fail(400, `status must be one of ${STATUSES.join(", ")}`);
            sets.push("status = ?");
            args.push(body.status);
        }
        if (body.parentId !== undefined) {
            const parent = checkGroup(body.parentId, me);
            if (parent instanceof Response) return parent;
            if (parent !== null && badParent(id, parent)) return fail(400, "a group can't be moved into itself or its own subgroups");
            sets.push("parent_id = ?");
            args.push(parent);
        }
        sets.push("updated_at = ?");
        args.push(now());
        db.query(`UPDATE material_groups SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
        return json(presentGroup(getGroup(id)!));
    }

    /** Deletes the group with its subgroups and the materials in them. */
    function removeGroup(req: Request, id: number): Response {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const g = getGroup(id);
        if (!g || g.owner_id !== me.id) return fail(404, "no such group");
        db.query("DELETE FROM material_groups WHERE id = ?").run(id);
        return new Response(null, { status: 204 });
    }

    // ---- Routes -------------------------------------------------------------

    type Req = Bun.BunRequest<string>;
    const withId = (fn: (req: Req, id: number) => Response | Promise<Response>) => (req: Req) => {
        const id = Number(req.params.id);
        return Number.isInteger(id) ? fn(req, id) : fail(404, "no such item");
    };

    const routes = {
        "/api/materials": { GET: listMaterials, POST: create },
        "/api/materials/:id": { GET: withId(getOne), PATCH: withId(update), DELETE: withId(remove) },
        "/api/materials/:id/download": { GET: withId(download) },
        "/api/materials/:id/file": { GET: withId(fileContent), POST: withId(replaceDeck) },
        "/api/materials/:id/copy": { POST: withId(copy) },
        "/api/groups": { GET: listGroups, POST: createGroup },
        "/api/groups/:id": { PATCH: withId(updateGroup), DELETE: withId(removeGroup) },
    };

    return { routes };
}
