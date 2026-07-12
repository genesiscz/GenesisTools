import { env } from "@app/utils/env";
import { defineConfig } from "@playwright/test";

/** Boards UI test suite. Requires a running dev-dashboard server (default http://localhost:3042);
 *  override with DD_QA_BASE_URL. Serial: specs create/mutate boards through the real API. */
export default defineConfig({
    testDir: `${import.meta.dirname}/specs`,
    globalSetup: `${import.meta.dirname}/global-setup.ts`,
    globalTeardown: `${import.meta.dirname}/global-teardown.ts`,
    timeout: 60_000,
    retries: 0,
    fullyParallel: false,
    workers: 1,
    use: {
        baseURL: env.dashboard.getQaBaseUrl(),
        trace: "retain-on-failure",
        viewport: { width: 1440, height: 900 },
        // System Chrome — no `playwright install` download needed.
        channel: "chrome",
    },
});
