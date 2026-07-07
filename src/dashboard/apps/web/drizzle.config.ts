// Relative import on purpose: drizzle-kit bundles this config and externalizes
// bare imports — "@app/utils/env" is not resolvable from this isolated workspace.

import { defineConfig } from "drizzle-kit";
import { env } from "../../../utils/env.client";

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
