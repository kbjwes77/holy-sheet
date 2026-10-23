// The study-material library: materials (a test's JSON, typed, named and tagged) and the
// groups that organize them. Every write belongs to the signed-in author; other users can see
// and download only what is published.
import type { Database } from "bun:sqlite";
import { parseSheetJson } from "../gen/testdef.ts";
import type { Auth, User } from "./auth.ts";
import { MATERIAL_TYPES, now, recordUsage, STATUSES, type MaterialType, type Status } from "./db.ts";
import { fail, json, readObject, sameOrigin } from "./http.ts";

export const MAX_NAME = 200;
export const MAX_TAGS = 10;
export const MAX_TAG = 30;
export const MAX_DESCRIPTION = 1000;
const MAX_CONTENT = 8 * 1024 * 1024;
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
            ...(r.content === undefined ? {} : { content: r.content }),
        }));
    };

    const SELECT = "SELECT m.id, m.owner_id, u.display_name AS owner_name, m.group_id, m.type, m.name, m.status, m.created_at, m.updated_at";

    const getMaterial = (id: number, withContent: boolean): MaterialRow | null =>
        db.query(`${SELECT}${withContent ? ", m.content" : ""} FROM study_materials m JOIN users u ON u.id = m.owner_id WHERE m.id = ?`).get(id) as MaterialRow | null;

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
        const type = q.get("type");
        if (type) {
            if (!isType(type)) return fail(400, "unknown type");
            where.push("m.type = ?");
            args.push(type);
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
        const m = getMaterial(id, true);
        if (!visible(m, me)) return fail(404, "no such material");
        return json(present([m], me)[0]);
    }

    async function create(req: Request): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const body = await readObject(req, MAX_CONTENT + 4096);
        if (body instanceof Response) return body;
        const name = parseName(body.name);
        if (!name) return fail(400, `the name must be 1–${MAX_NAME} characters`);
        if (!isType(body.type)) return fail(400, `type must be one of ${MATERIAL_TYPES.join(", ")}`);
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
        return json(present([getMaterial(id, true)!], me)[0]);
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

    /** The test JSON as a file download. */
    function download(req: Request, id: number): Response {
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const m = getMaterial(id, true);
        if (!visible(m, me)) return fail(404, "no such material");
        if (m.owner_id !== me.id) recordUsage(db, me.id, "material_downloaded", 1, { id });
        const file = `${m.name.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 80).trim() || "material"}.json`;
        return new Response(m.content, { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${file}"`, "cache-control": "no-store" } });
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
            const nid = Number(db.query("INSERT INTO study_materials (owner_id, group_id, type, name, content, status, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, 'draft', ?, ?)").run(me.id, m.type, m.name, m.content!, t, t).lastInsertRowid);
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
        "/api/materials/:id/copy": { POST: withId(copy) },
        "/api/groups": { GET: listGroups, POST: createGroup },
        "/api/groups/:id": { PATCH: withId(updateGroup), DELETE: withId(removeGroup) },
    };

    return { routes };
}
