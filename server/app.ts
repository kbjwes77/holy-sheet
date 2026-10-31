// Assembles the API: accounts, the material library, the (plan-gated) grader bridge and saved grading runs.
import type { Database } from "bun:sqlite";
import { createGraderApi, type GraderApiOptions } from "../web/grader-api.ts";
import { createAuth, type AuthOptions } from "./auth.ts";
import { createBilling, type BillingOptions } from "./billing.ts";
import { recordUsage } from "./db.ts";
import { createMailer, type EmailOptions } from "./email.ts";
import { createGradeRuns } from "./grade-runs.ts";
import { createMaterialsApi } from "./materials.ts";

export interface AppOptions extends AuthOptions {
    db: Database;
    root: string;
    grader?: Partial<GraderApiOptions>;
    billing?: BillingOptions;
    email?: EmailOptions;
    /** Grading jobs one user may have unfinished, and that may be working across all users (defaults 1 and 3). */
    limits?: { jobsPerUser?: number; jobs?: number };
}

export function createApp(o: AppOptions) {
    const mailer = createMailer(o.email);
    const auth = createAuth(o.db, o, mailer);
    const materials = createMaterialsApi(o.db, auth);
    const billing = createBilling(o.db, auth, o.billing);
    const gradeRuns = createGradeRuns(o.db, auth);
    const graderApi = createGraderApi({
        root: o.root,
        ...o.grader,
        // Seeing the grader's status needs only an account; starting a job needs a plan that can grade.
        authorize: (req, action) => {
            const user = action === "job" ? auth.requireGrader(req) : auth.requireUser(req);
            return user instanceof Response ? user : { userId: user.id };
        },
        maxJobsPerUser: o.limits?.jobsPerUser ?? 1,
        maxJobs: o.limits?.jobs ?? 3,
        admit: (userId, { pages }) => auth.admitPages(userId, pages),
        onJob: (userId, info) => {
            recordUsage(o.db, userId, "grade_run", 1, { name: info.name, hasTest: info.hasTest });
            const runId = gradeRuns.start(userId, { uploadName: info.name, testTitle: info.testTitle, materialId: info.materialId });
            auth.chargePages(userId, info.pages, runId);
            return runId;
        },
        onDone: (runId, result, userId) => {
            gradeRuns.finish(runId, result);
            // No model was called, so the run cost nothing: give its pages back.
            if (result.modelRequests === 0) auth.refundPages(userId, result.pages, runId);
        },
    });
    return {
        db: o.db,
        auth,
        mailer,
        graderApi,
        gradeRuns,
        routes: { ...auth.routes, ...materials.routes, ...billing.routes, ...graderApi.routes, ...gradeRuns.routes },
        shutdown(): void {
            graderApi.shutdown();
            auth.stop();
        },
    };
}
