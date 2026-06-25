import { env } from "@app/utils/env";
import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: import.meta.dirname,
    timeout: 90_000,
    retries: 0,
    use: {
        baseURL: env.dashboard.getQaBaseUrl(),
        trace: "retain-on-failure",
    },
});
