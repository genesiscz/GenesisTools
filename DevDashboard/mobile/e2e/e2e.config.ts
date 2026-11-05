import type { E2eProjectConfig } from "../../../src/utils/e2e/project";

/**
 * The DevDashboard mobile suite for `tools e2e`: WebdriverIO with Appium through wdio.conf.ts, run from the app folder
 * (its node_modules has the runner), against the app mobile.config.ts describes. A flow that pairs with a side agent
 * takes it as `--env DD_TEST_AGENT=http://127.0.0.1:<port>`.
 */
export default {
    id: "dev-dashboard",
    title: "DevDashboard mobile",
    cwd: "..",
    runner: { kind: "wdio", config: "wdio.conf.ts", mobile: "mobile.config.ts" },
    specs: { dir: "specs" },
    pages: "pages",
    suites: {
        flows: ["pairing.flow", "answer-queue.flow", "agents.flow", "terminal.flow"],
        screens: ["screens.tour"],
    },
} satisfies E2eProjectConfig;
