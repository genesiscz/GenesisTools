import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Type-safe environment variables using @t3-oss/env-core
 *
 * This ensures environment variables are validated at runtime
 * and provides type-safe access throughout the application.
 */
export const env = createEnv({
    server: {
        DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
        NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
