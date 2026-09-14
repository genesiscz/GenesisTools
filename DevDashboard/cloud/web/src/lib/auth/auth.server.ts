/**
 * The Better-Auth instance. SERVER-ONLY.
 *
 * This is the concrete auth ADAPTER. Everything else in the app talks to the thin auth interface
 * in `auth-service.ts` (signUp/signIn/getSession/signOut/requireAuth), so the choice of Better-Auth
 * is contained here.
 *
 * ── WORKOS / BETTER-AUTH FLAG (per task) ──────────────────────────────────────
 * The user's stack answer said "auth same as src/dashboard = WorkOS"; the auth answer said
 * "better-auth sqlite". The orchestrator chose Better-Auth + SQLite and documented WorkOS as the
 * alternate adapter. To swap to WorkOS later: replace this file's `betterAuth(...)` with the WorkOS
 * AuthKit handler (the reference wires `@workos/authkit-tanstack-react-start` in
 * src/dashboard/apps/web/src/start.ts + routes/auth/callback.tsx), re-point `auth-service.ts` at it,
 * and set the WORKOS_* env vars. The rest of the app is unaffected.
 *
 * The DB driver (sqlite now, postgres-ready) is selected in `lib/db/index.ts`; the adapter's
 * `provider` here is derived from the same env so they never disagree.
 */

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "@/lib/db";
import { schema } from "@/lib/db/schema";
import { getCloudEnv } from "@/lib/server/env";

const env = getCloudEnv();
const provider = env.databaseDriver === "postgres" ? "pg" : "sqlite";

/**
 * Signup currently trusts whatever address it is handed. No mail provider is wired anywhere in this
 * app, so Better-Auth has nothing to send a verification link with — flipping the flag on today
 * would not harden anything, it would strand every new account unverified forever.
 *
 * So the flag stays off and PRODUCTION refuses to boot instead, the same fail-closed shape as the
 * missing-DD_CLOUD_AUTH_SECRET guard in `server/env.ts`. A deploy cannot silently ship open signup,
 * and local development is untouched. Wiring a provider and flipping this constant is one change.
 */
/** Off until a mail provider exists. Read by the guard below AND by the Better-Auth config. */
export const REQUIRE_EMAIL_VERIFICATION = false;

/**
 * Production must not boot with open signup. Exported and parameterised so both controls can be
 * pinned in a test: production without verification throws, and every other environment boots.
 */
export function assertEmailVerificationSafe(nodeEnv: string, required: boolean = REQUIRE_EMAIL_VERIFICATION): void {
    if (nodeEnv !== "production" || required) {
        return;
    }

    throw new Error(
        "Email verification is disabled and no mail provider is wired, so anyone can sign up with an " +
            "address they do not control — and an unverified account can pair devices and claim a managed " +
            "subdomain. Wire Better-Auth's `emailVerification.sendVerificationEmail`, then set " +
            "REQUIRE_EMAIL_VERIFICATION = true in lib/auth/auth.server.ts before deploying."
    );
}

assertEmailVerificationSafe(env.nodeEnv);

export const auth = betterAuth({
    baseURL: env.appBaseUrl,
    secret: env.authSecret,
    database: drizzleAdapter(db, {
        provider,
        schema,
    }),
    emailAndPassword: {
        enabled: true,
        // Kept in lockstep with the production guard above; neither moves without the other.
        requireEmailVerification: REQUIRE_EMAIL_VERIFICATION,
        autoSignIn: true,
    },
    session: {
        expiresIn: 60 * 60 * 24 * 30, // 30 days
        updateAge: 60 * 60 * 24, // refresh once a day
    },
    plugins: [tanstackStartCookies()],
});

export type Auth = typeof auth;
