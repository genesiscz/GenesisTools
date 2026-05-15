import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Type-safe environment variables using @t3-oss/env-core
 *
 * DATABASE_URL removed — SQLite file path is resolved in drizzle/index.ts
 * via SQLITE_PATH env var (defaults to .data/dashboard.sqlite).
 */
export const env = createEnv({
    server: {
        NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
        SQLITE_PATH: z.string().optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
