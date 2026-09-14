import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./tests-e2e/constants";

const PORT = 7251;
const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Throwaway, test-only SQLite file. globalSetup resets it (guarded to this `.e2e/` path) and runs
 * `db:migrate` against it before the webServer boots — see tests-e2e/global-setup.ts. NEVER point this
 * at the dev/prod DB; only this file may be reset.
 */
const TEST_DB = resolve(ROOT, ".e2e/cloud-e2e.db");

/**
 * Both this Playwright process (which runs globalSetup) AND the spawned webServer must agree on the
 * test DB. Setting it here propagates to globalSetup via process.env and to the webServer via its env.
 */
process.env.DD_CLOUD_DATABASE_URL = TEST_DB;

export default defineConfig({
    testDir: "./tests-e2e",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    // The Vite DEV server compiles routes on-demand; under heavy concurrency a cold first hit can
    // transiently throw "(intermediate value) is not a function" in the route lazy-load and bounce to
    // the error boundary. Cap workers so the dev server keeps up, and retry once to absorb the rare
    // cold-compile blip (the dashboard routes are the ones affected).
    workers: process.env.CI ? 2 : 3,
    retries: process.env.CI ? 2 : 1,
    reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        trace: "on-first-retry",
        screenshot: "only-on-failure",
    },
    projects: [
        { name: "setup", testMatch: /auth\.setup\.ts/ },
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
            dependencies: ["setup"],
        },
    ],
    webServer: {
        // Reset + migrate the throwaway test DB BEFORE the server opens it, in the same process chain.
        // Playwright starts the webServer plugin BEFORE globalSetup, so migrating in globalSetup races
        // the server's first signup ("no such table: user") — see tests-e2e/prepare-db.ts.
        command: "bun run tests-e2e/prepare-db.ts && bun run dev",
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
            DD_CLOUD_DATABASE_URL: TEST_DB,
            DD_CLOUD_DATABASE_DRIVER: "sqlite",
            DD_CLOUD_AUTH_SECRET: "e2e-secret",
            NODE_ENV: "test",
            // Explicitly omit STRIPE_* / CLOUDFLARE_* so billing + provisioning stay in deterministic
            // "demo mode" (verified configured:false states).
        },
    },
});
