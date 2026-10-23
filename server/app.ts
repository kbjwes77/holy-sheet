// Assembles the API: accounts, the material library and the (plan-gated) grader bridge.
import type { Database } from "bun:sqlite";
import { createGraderApi, type GraderApiOptions } from "../web/grader-api.ts";
import { createAuth, type AuthOptions } from "./auth.ts";
import { createBilling, type BillingOptions } from "./billing.ts";
import { recordUsage } from "./db.ts";
import { createMaterialsApi } from "./materials.ts";

export interface AppOptions extends AuthOptions {
    db: Database;
    root: string;
    grader?: Partial<GraderApiOptions>;
    billing?: BillingOptions;
}

export function createApp(o: AppOptions) {
    const auth = createAuth(o.db, o);
    const materials = createMaterialsApi(o.db, auth);
    const billing = createBilling(o.db, auth, o.billing);
    const graderApi = createGraderApi({
        root: o.root,
        ...o.grader,
        // Seeing the grader's status needs only an account; starting a job needs a plan that can grade.
        authorize: (req, action) => {
            const user = action === "job" ? auth.requireGrader(req) : auth.requireUser(req);
            return user instanceof Response ? user : { userId: user.id };
        },
        onJob: (userId, info) => recordUsage(o.db, userId, "grade_run", 1, info),
    });
    return {
        db: o.db,
        auth,
        graderApi,
        routes: { ...auth.routes, ...materials.routes, ...billing.routes, ...graderApi.routes },
        shutdown(): void {
            graderApi.shutdown();
            auth.stop();
        },
    };
}
