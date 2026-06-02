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

export const auth = betterAuth({
    baseURL: env.appBaseUrl,
    secret: env.authSecret,
    database: drizzleAdapter(db, {
        provider,
        schema,
    }),
    emailAndPassword: {
        enabled: true,
        // Email verification is out of scope for the stub; flip on + wire an email provider for prod.
        requireEmailVerification: false,
        autoSignIn: true,
    },
    session: {
        expiresIn: 60 * 60 * 24 * 30, // 30 days
        updateAge: 60 * 60 * 24, // refresh once a day
    },
    plugins: [tanstackStartCookies()],
});

export type Auth = typeof auth;
