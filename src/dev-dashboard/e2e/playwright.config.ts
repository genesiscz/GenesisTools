import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: import.meta.dirname,
    timeout: 90_000,
    retries: 0,
    use: {
        baseURL: process.env.DD_QA_BASE_URL ?? "http://localhost:3042",
        trace: "retain-on-failure",
    },
});
