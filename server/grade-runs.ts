// Saved grading runs. Each job the grader starts gets a row here, and the CLI's CSV is saved into it
// when the CLI exits, so grades outlive the browser tab and the job's temporary files. The page then
// saves what the teacher adds: curves (points per student) and the per-question results from the
// review. Viewing old runs needs only an account, so a lapsed subscription doesn't lock anyone out
// of grades they already paid for.
import type { Database } from "bun:sqlite";
import { applyCurves, parseCsv } from "../src/csv.ts";
import type { Skipped } from "../src/report.ts";
import type { Auth } from "./auth.ts";
import { now } from "./db.ts";
import { fail, json, readObject, sameOrigin } from "./http.ts";

/**
 * running: the CLI hasn't exited. graded: every submission graded. partial: some were skipped.
 * failed: the CLI stopped with an error. cancelled: stopped by the user. interrupted: the server
 * stopped while it ran.
 */
export type RunStatus = "running" | "graded" | "partial" | "failed" | "cancelled" | "interrupted";

export const MAX_RUN_NAME = 200;
/** The most points a curve may add or take away. */
export const MAX_CURVE = 1000;
const MAX_QUESTIONS = 256;
const MAX_SKIPPED = 500;
const PAGE = 50;

/** What the grader knows about a run when it ends. */
export interface RunResult {
    exitCode: number | null;
    cancelled: boolean;
    csv: string;
    totals?: string;
    fatal?: string;
    skipped: Skipped[];
}

/** Per question: its number (1-based), how many got it right, how many answered. */
export type QuestionStat = [question: number, correct: number, answered: number];

interface RunRow {
    id: number;
    material_id: number | null;
    name: string;
    upload_name: string;
    status: RunStatus;
    exit_code: number | null;
    students: number;
    average: number | null;
    created_at: number;
    finished_at: number | null;
    csv?: string;
    curves?: string | null;
    questions?: string | null;
    details?: string | null;
}

const SUMMARY_COLUMNS = "id, material_id, name, upload_name, status, exit_code, students, average, created_at, finished_at";

/** Students graded and their average percent, from the grader's CSV. */
function csvStats(csv: string): { students: number; average: number | null } {
    try {
        const body = parseCsv(csv).slice(1);
        const pct = body.map((r) => Number(r[3])).filter(Number.isFinite);
        return { students: body.length, average: pct.length ? Math.round((pct.reduce((a, b) => a + b, 0) / pct.length) * 10) / 10 : null };
    } catch {
        return { students: 0, average: null };
    }
}

const parseJson = <T>(text: string | null | undefined, fallback: T): T => {
    if (!text) return fallback;
    try {
        return JSON.parse(text) as T;
    } catch {
        return fallback;
    }
};

const isInt = (v: unknown): v is number => Number.isInteger(v);

export function createGradeRuns(db: Database, auth: Auth) {
    // A job still marked running when the server starts died with the previous process. That's
    // not the user's doing, so its pages are refunded, dated with the charge so the refund lands
    // in the month that was charged.
    db.transaction(() => {
        db.query(
            `INSERT INTO usage_events (user_id, kind, quantity, metadata, created_at)
             SELECT u.user_id, 'grade_pages', -SUM(u.quantity), json_object('runId', r.id, 'refund', json('true'), 'interrupted', json('true')), MIN(u.created_at)
             FROM grade_runs r JOIN usage_events u ON u.kind = 'grade_pages' AND u.user_id = r.owner_id AND json_extract(u.metadata, '$.runId') = r.id
             WHERE r.status = 'running'
             GROUP BY r.id HAVING SUM(u.quantity) > 0`,
        ).run();
        db.query("UPDATE grade_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now());
    })();

    /** Records a job as it starts; returns the run's id. The test material is kept only if the user can see it. */
    function start(userId: number, info: { uploadName: string; testTitle?: string; materialId?: number }): number {
        const material =
            info.materialId !== undefined &&
            (db.query("SELECT id FROM study_materials WHERE id = ? AND (owner_id = ? OR status = 'published')").get(info.materialId, userId) as { id: number } | null);
        const name = (info.testTitle?.trim() || info.uploadName.replace(/\.zip$/i, "")).slice(0, MAX_RUN_NAME);
        const row = db
            .query("INSERT INTO grade_runs (owner_id, material_id, name, upload_name, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
            .get(userId, material ? material.id : null, name, info.uploadName, now()) as { id: number };
        return row.id;
    }

    /** Saves a run's outcome. Only a running run is updated, so one already marked interrupted stays that way. */
    function finish(runId: number, r: RunResult): void {
        const status: RunStatus = r.cancelled ? "cancelled" : r.exitCode === 0 ? "graded" : r.exitCode === 2 ? "partial" : "failed";
        const { students, average } = csvStats(r.csv);
        const details = { totals: r.totals, fatal: r.fatal, skipped: r.skipped.slice(0, MAX_SKIPPED) };
        db.query("UPDATE grade_runs SET status = ?, exit_code = ?, csv = ?, details = ?, students = ?, average = ?, finished_at = ? WHERE id = ? AND status = 'running'").run(
            status,
            r.cancelled ? null : r.exitCode,
            r.csv,
            JSON.stringify(details),
            students,
            average,
            now(),
            runId,
        );
    }

    const present = (r: RunRow) => ({
        id: r.id,
        materialId: r.material_id,
        name: r.name,
        uploadName: r.upload_name,
        status: r.status,
        exitCode: r.exit_code,
        students: r.students,
        average: r.average,
        createdAt: r.created_at,
        finishedAt: r.finished_at,
    });

    const getRun = (id: number, ownerId: number, full: boolean) =>
        db.query(`SELECT ${SUMMARY_COLUMNS}${full ? ", csv, curves, questions, details" : ""} FROM grade_runs WHERE id = ? AND owner_id = ?`).get(id, ownerId) as RunRow | null;

    function list(req: Request): Response {
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const url = new URL(req.url);
        const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
        const { total } = db.query("SELECT COUNT(*) AS total FROM grade_runs WHERE owner_id = ?").get(me.id) as { total: number };
        const rows = db.query(`SELECT ${SUMMARY_COLUMNS} FROM grade_runs WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(me.id, PAGE, offset) as RunRow[];
        return json({ total, runs: rows.map(present) });
    }

    function getOne(req: Request, id: number): Response {
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const r = getRun(id, me.id, true);
        if (!r) return fail(404, "no such grading run");
        return json({
            run: {
                ...present(r),
                csv: r.csv ?? "",
                curves: parseJson<number[]>(r.curves, []),
                questions: parseJson<QuestionStat[]>(r.questions, []),
                ...parseJson<{ totals?: string; fatal?: string; skipped: Skipped[] }>(r.details, { skipped: [] }),
            },
        });
    }

    /** The CSV with any curve applied, as a download. */
    function csv(req: Request, id: number): Response {
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const r = getRun(id, me.id, true);
        if (!r) return fail(404, "no such grading run");
        const file = `${r.name.replace(/[^\w.\- ]+/g, "_").trim() || "grades"}-grades.csv`;
        return new Response(applyCurves(r.csv ?? "", parseJson<number[]>(r.curves, [])), {
            headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${file}"`, "cache-control": "no-store" },
        });
    }

    /** Renames a run, or saves its curves (one entry per CSV row) or per-question results. */
    async function update(req: Request, id: number): Promise<Response> {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const body = await readObject(req);
        if (body instanceof Response) return body;
        const r = getRun(id, me.id, true);
        if (!r) return fail(404, "no such grading run");

        const sets: string[] = [];
        const values: (string | number | null)[] = [];
        if (body.name !== undefined) {
            const name = typeof body.name === "string" ? body.name.trim() : "";
            if (!name || name.length > MAX_RUN_NAME) return fail(400, `the name must be 1–${MAX_RUN_NAME} characters`);
            sets.push("name = ?");
            values.push(name);
        }
        if (body.curves !== undefined) {
            if (r.status === "running") return fail(409, "the run hasn't finished");
            const rows = csvStats(r.csv ?? "").students;
            const c = body.curves;
            if (!Array.isArray(c) || c.length !== rows || !c.every((v) => isInt(v) && Math.abs(v) <= MAX_CURVE)) {
                return fail(400, `curves must be ${rows} whole numbers of points, each at most ${MAX_CURVE} either way`);
            }
            const curves = c as number[];
            const curved = csvStats(applyCurves(r.csv ?? "", curves));
            sets.push("curves = ?", "average = ?");
            values.push(curves.some(Boolean) ? JSON.stringify(curves) : null, curved.average);
        }
        if (body.questions !== undefined) {
            const q = body.questions;
            const ok =
                Array.isArray(q) &&
                q.length <= MAX_QUESTIONS &&
                q.every((s) => Array.isArray(s) && s.length === 3 && s.every((v) => isInt(v) && v >= 0) && s[0] >= 1 && s[1] <= s[2]);
            if (!ok) return fail(400, "questions must be [question, correct, answered] entries");
            sets.push("questions = ?");
            values.push(JSON.stringify(q));
        }
        if (!sets.length) return fail(400, "nothing to change");
        db.query(`UPDATE grade_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
        return json({ run: present(getRun(id, me.id, false)!) });
    }

    function remove(req: Request, id: number): Response {
        if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
        const me = auth.requireUser(req);
        if (me instanceof Response) return me;
        const r = getRun(id, me.id, false);
        if (!r) return fail(404, "no such grading run");
        if (r.status === "running") return fail(409, "cancel the run before deleting it");
        db.query("DELETE FROM grade_runs WHERE id = ?").run(id);
        return new Response(null, { status: 204 });
    }

    type Req = Bun.BunRequest<string> & { params: Record<string, string> };
    const withId = (fn: (req: Req, id: number) => Response | Promise<Response>) => (req: Req) => {
        const id = Number(req.params.id);
        return Number.isInteger(id) ? fn(req, id) : fail(404, "no such grading run");
    };

    const routes = {
        "/api/grade-runs": { GET: list },
        "/api/grade-runs/:id": { GET: withId(getOne), PATCH: withId(update), DELETE: withId(remove) },
        "/api/grade-runs/:id/csv": { GET: withId(csv) },
    };

    return { routes, start, finish };
}
