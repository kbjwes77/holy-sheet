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
        onJob: (userId, info) => {
            recordUsage(o.db, userId, "grade_run", 1, { name: info.name, hasTest: info.hasTest });
            return gradeRuns.start(userId, { uploadName: info.name, testTitle: info.testTitle, materialId: info.materialId });
        },
        onDone: (runId, result) => gradeRuns.finish(runId, result),
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
