import { env as appEnv } from "@app/utils/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Type-safe environment variables using @t3-oss/env-core
 *
 * DATABASE_URL removed — SQLite file path is resolved in drizzle/index.ts
 * via SQLITE_PATH env var (defaults to .data/dashboard.sqlite).
 *
 * ANTHROPIC_API_KEY is required for the AI chat route; if absent,
 * /api/ai-chat returns HTTP 503 with a descriptive error.
 */
export const env = createEnv({
    server: {
        NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
        SQLITE_PATH: z.string().optional(),
        MIGRATIONS_DIR: z.string().optional(),
        ANTHROPIC_API_KEY: z.string().optional(),
        // WorkOS AuthKit — required for auth to work. Validated at startup so a
        // misconfigured deploy fails fast instead of silently running auth-broken.
        WORKOS_API_KEY: z.string().min(1),
        WORKOS_CLIENT_ID: z.string().min(1),
        WORKOS_REDIRECT_URI: z.string().url(),
        WORKOS_COOKIE_PASSWORD: z.string().min(32),
        // MCP endpoint auth. Both must be set to enable /mcp; otherwise /mcp
        // is disabled (501). MCP has no browser session, so it is bound to a
        // single configured owner user and gated by a bearer token.
        MCP_BEARER_TOKEN: z.string().min(16).optional(),
        MCP_USER_ID: z.string().min(1).optional(),
    },
    runtimeEnv: appEnv.getProcessEnv(),
    emptyStringAsUndefined: true,
});
