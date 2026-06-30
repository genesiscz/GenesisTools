import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for the dashboard.
 *
 * Auth: the server honours `E2E_AUTH_BYPASS=1` / `VITE_E2E_AUTH_BYPASS=1` and
 * resolves every request to the fixed user `"dev-user"` WITHOUT WorkOS, so
 * tests need NO login / storageState — they just navigate. See
 * `src/lib/auth/requireUser.ts`.
 *
 * Data: one on-disk SQLite test DB at SQLITE_PATH (throwaway, under /tmp).
 * Because there is ONE db and ONE user, the suite runs with a single worker so
 * tests never stomp each other's rows. Each spec resets the tables it owns in a
 * beforeEach (see tests/e2e/support/seed.ts).
 *
 * The final authoritative run uses the Vite dev server (NOT a production
 * preview): pages resolve the client user id via `import.meta.env.DEV` which is
 * only true under dev, so a preview build would leave the client user id null.
 */

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_DB_PATH = process.env.SQLITE_PATH ?? "/tmp/dash-e2e/dashboard-e2e.sqlite";

const E2E_ENV = {
    NODE_ENV: "development",
    SQLITE_PATH: TEST_DB_PATH,
    WORKOS_API_KEY: "sk_test_dummy_e2e",
    WORKOS_CLIENT_ID: "client_dummy_e2e",
    WORKOS_REDIRECT_URI: `${BASE_URL}/auth/callback`,
    WORKOS_COOKIE_PASSWORD: "e2e_test_cookie_password_at_least_32_chars_long_0001",
    E2E_AUTH_BYPASS: "1",
    VITE_E2E_AUTH_BYPASS: "1",
};

export default defineConfig({
    testDir: "./tests/e2e",
    testMatch: "**/*.spec.ts",
    // ONE worker: shared SQLite + shared user. Do not parallelise.
    workers: 1,
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
    use: {
        baseURL: BASE_URL,
        trace: "on-first-retry",
        screenshot: "only-on-failure",
        actionTimeout: 15_000,
        navigationTimeout: 30_000,
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: {
        command: "./node_modules/.bin/vite dev --port 3100 --host 127.0.0.1",
        url: BASE_URL,
        timeout: 120_000,
        reuseExistingServer: true,
        env: E2E_ENV,
        stdout: "ignore",
        stderr: "pipe",
    },
});
