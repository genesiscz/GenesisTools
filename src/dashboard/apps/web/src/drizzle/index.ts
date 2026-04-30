import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * Create Neon HTTP client using type-safe environment variables
 *
 * The Neon HTTP client is serverless-friendly and works in:
 * - TanStack Start server functions
 * - Vercel Edge Functions
 * - Cloudflare Workers
 * - Any serverless environment
 */
const sql = neon(env.DATABASE_URL);

/**
 * Drizzle ORM instance with full schema
 *
 * Features:
 * - Type-safe queries
 * - Automatic type inference
 * - Compile-time validation
 * - IntelliSense support
 */
export const db = drizzle(sql, { schema });

// Re-export schema and types for convenience
export * from "./schema";
