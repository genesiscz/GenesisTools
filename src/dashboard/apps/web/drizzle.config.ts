import { defineConfig } from "drizzle-kit";

export default defineConfig({
    schema: "./src/drizzle/schema.ts",
    out: "./src/drizzle/migrations",
    dialect: "sqlite",
    dbCredentials: {
        url: process.env.SQLITE_PATH ?? ".data/dashboard.sqlite",
    },
    verbose: true,
    strict: true,
});
