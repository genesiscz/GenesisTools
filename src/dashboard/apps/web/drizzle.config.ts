import { env } from "@app/utils/env";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
    schema: "./src/drizzle/schema.ts",
    out: "./src/drizzle/migrations",
    dialect: "sqlite",
    dbCredentials: {
        url: env.db.getSqlitePath(),
    },
    verbose: true,
    strict: true,
});
