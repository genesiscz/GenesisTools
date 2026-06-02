import { defineConfig } from "drizzle-kit";

// SQLite stub config. For the Postgres prod path, set dialect: "postgresql" and point at
// schema.pg.ts (see lib/db/index.ts + the notes file).
export default defineConfig({
    dialect: "sqlite",
    schema: "./src/lib/db/schema.ts",
    out: "./db/migrations",
    dbCredentials: {
        url: process.env.DD_CLOUD_DATABASE_URL ?? "./data/cloud.db",
    },
});
