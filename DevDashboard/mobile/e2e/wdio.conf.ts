import { mkdirSync } from "node:fs";
import path from "node:path";
import { getDevDashboardBundleId } from "./bundle-id";
import { e2eRun } from "./run";
import {
    failureScreenshotPath,
    recordTestResult,
    wdioTestResult,
    xcuitestCapabilities,
} from "../../../src/utils/e2e/spec-env";

// ── App under test ───────────────────────────────────────────────────────────
// Two modes:
//   1. Reinstall mode — set DD_APP_PATH to a built binary; Appium installs+launches it fresh:
//        DD_APP_PATH=ios/build/Build/Products/Debug-iphonesimulator/mobile.app bun run e2e
//   2. Attach mode (DEFAULT when DD_APP_PATH is empty) — Appium launches the ALREADY-INSTALLED
//      dev-client by bundle id with noReset, so the running Metro binding + dev JS are preserved.
//      This is the fast inner-loop path: rebuild JS via Metro, just relaunch to pick it up.
const APP_PATH = process.env.DD_APP_PATH ?? "";
const BUNDLE_ID = getDevDashboardBundleId();

// ── iOS Simulator capabilities (default) ─────────────────────────────────────
// Under `tools e2e` the simulator, its Appium, its own WebDriverAgent and MJPEG ports and `isHeadless` come from the
// run (`E2E_*`, see e2e/README.md): XCUITest kills every WDA on its port that belongs to another simulator, and a wrong
// `isHeadless` reboots the simulator on Xcode 27. A plain `bun run e2e` falls back to the device below.
const iosCap: WebdriverIO.Capabilities = xcuitestCapabilities(e2eRun, {
    bundleId: BUNDLE_ID,
    app: APP_PATH || undefined,
    deviceName: process.env.DD_SIM_DEVICE ?? "iPhone 17 Pro Max",
    platformVersion: process.env.DD_SIM_OS ?? "26.5",
});

// ── Android Emulator capabilities (opt-in via DD_PLATFORM=android) ────────────
// NOTE (D20): running on Android additionally needs the `appium-uiautomator2-driver`
// installed (`appium driver install uiautomator2`) — it is NOT bundled here. iOS is the
// default lane so the absence of that driver never blocks the green iOS run. Adding the
// Android driver is an open decision (see e2e/README.md + research/21 notes); flag before
// installing.
const ANDROID_DEVICE = process.env.DD_AVD ?? "Pixel_7_API_34";
const ANDROID_OS = process.env.DD_EMU_OS ?? "14";

const androidCap: WebdriverIO.Capabilities = {
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:deviceName": ANDROID_DEVICE,
    "appium:avd": ANDROID_DEVICE,
    "appium:platformVersion": ANDROID_OS,
    "appium:app": APP_PATH,
    "appium:newCommandTimeout": 240,
    "appium:appWaitActivity": "*",
    "appium:autoGrantPermissions": true,
};

const platform = process.env.DD_PLATFORM === "android" ? "android" : "ios";

// Under `tools e2e` screenshots, the runner's logs and one JSON line per test go into the spec's run folder, which the
// tool reads into its summary. A plain `bun run e2e` writes screenshots to e2e/screenshots and records no results.
const SHOTS_DIR = e2eRun.shotsDir ?? path.join(import.meta.dirname, "screenshots");

export const config: WebdriverIO.Config = {
    runner: "local",

    // Point the runner at the out-of-band Appium server explicitly. Without hostname/port/path,
    // WDIO v9's session bootstrap builds an invalid connection URL ("TypeError: Invalid URL" at
    // newSession). `tools e2e` passes the simulator's own Appium port.
    hostname: process.env.DD_APPIUM_HOST ?? "127.0.0.1",
    port: e2eRun.appiumPort ?? Number(process.env.DD_APPIUM_PORT ?? "4723"),
    path: "/",

    // Resolve the e2e tsconfig relative to THIS file, not process.cwd() — `bun run e2e` runs
    // from the mobile root, where a bare "./tsconfig.json" would bind to the APP tsconfig
    // (which `exclude`s e2e). tsx loads this config as ESM, so `import.meta.dirname` is set.
    tsConfigPath: path.join(import.meta.dirname, "tsconfig.json"),

    specs: ["./specs/**/*.spec.ts"],
    maxInstances: 1,

    capabilities: [platform === "android" ? androidCap : iosCap],

    logLevel: "info",
    ...(e2eRun.runDir ? { outputDir: path.join(e2eRun.runDir, "wdio-logs") } : {}),
    bail: 0,
    waitforTimeout: 10_000,
    // The first session builds WebDriverAgent with xcodebuild, which can take minutes.
    connectionRetryTimeout: 600_000,
    connectionRetryCount: 3,

    // The Appium server runs out-of-band: `tools e2e` starts the simulator's own when none answers; for a plain run
    // start one with `bun run e2e:appium` (default port 4723).
    services: [],

    framework: "mocha",
    reporters: ["spec"],
    mochaOpts: {
        ui: "bdd",
        timeout: 120_000,
    },

    onPrepare() {
        mkdirSync(SHOTS_DIR, { recursive: true });
    },

    // Per-spec-file isolation. The suite shares ONE app process (noReset), and specs navigate deep
    // into (more) sub-screens / terminals; without a reset, a later spec inherits wherever the prior
    // one left the UI (e.g. stuck on a (more) detail with the tab bar hidden → "~Pulse not displayed").
    // Terminate + relaunch between spec files returns to a known root: boot-restore reopens the gate
    // and lands on the tabs, so every spec's before() starts from the same place.
    async beforeSuite() {
        const bundleId = BUNDLE_ID;
        try {
            await browser.execute("mobile: terminateApp", { bundleId });
        } catch {
            // App may not be running yet on the very first suite — launching below is enough.
        }

        await browser.execute("mobile: launchApp", { bundleId });
        // Give boot-restore time to rehydrate + the splash to hand off to the tabs/connect.
        await browser.pause(4000);

        // Force-repoint to a side-port Agent when DD_TEST_AGENT is set (`tools e2e … --env DD_TEST_AGENT=<url>`).
        // Boot-restore reconnects to the LAST-SAVED connection (e.g. the user's real :3042), so a spec's
        // `if (connectPage.isShown())` pairing guard is false and never re-points — the app keeps talking to the stored
        // Agent. The `pair` deep-link applies UNCONDITIONALLY (upserts + marks active), so injecting it here once per
        // suite pins EVERY spec to the side Agent regardless of stored state. No-op when unset.
        const testAgent = process.env.DD_TEST_AGENT;
        if (testAgent) {
            const uri = `devdashboard://pair?tier=cloudflared-self&baseUrl=${encodeURIComponent(testAgent)}&username=e2e`;
            try {
                await browser.execute("mobile: deepLink", { url: uri, bundleId });
                // A link never connects by itself: confirm the address on the pair screen.
                const confirm = await $("~pair-confirm");
                await confirm.waitForDisplayed({ timeout: 10_000 });
                await confirm.click();
                await browser.pause(3000);
            } catch {
                // A spec's own before() re-pairs too; a failed deep-link here is not fatal.
            }
        }
    },

    // One result line per test for `tools e2e`, and a screenshot of every genuinely FAILING test. A skipped/pending
    // test reports `passed === false` too (`result.retries.attempts === -1`); `wdioTestResult` records it as a skip
    // and takes no screenshot, so an all-green run never litters FAIL_*.png for the data-gated `this.skip()` cases.
    async afterTest(test, _context, result) {
        let line = wdioTestResult({ test, result });
        const screenshot = line.state === "failed" ? failureScreenshotPath({ shotsDir: SHOTS_DIR }, test) : undefined;

        if (screenshot) {
            try {
                await browser.saveScreenshot(screenshot);
                line = { ...line, screenshot };
            } catch {
                // A session that already crashed can't screenshot; the spec error itself is the signal.
            }
        }

        recordTestResult(e2eRun, line);
    },
};
