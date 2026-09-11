import { defineConfig } from "drizzle-kit";
// Relative, not the `@/` alias: drizzle-kit loads this file outside the Vite resolver.
import { getCloudEnv } from "./src/lib/server/env";

// SQLite stub config. For the Postgres prod path, set dialect: "postgresql" and point at
// schema.pg.ts (see lib/db/index.ts + the notes file).
export default defineConfig({
    dialect: "sqlite",
    schema: "./src/lib/db/schema.ts",
    out: "./db/migrations",
    dbCredentials: {
        // The shared accessor, so the CLI and the running app can never drift onto different files.
        url: getCloudEnv().databaseUrl,
    },
});
