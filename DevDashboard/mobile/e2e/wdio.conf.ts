import { mkdirSync } from "node:fs";
import path from "node:path";

// ── App under test ───────────────────────────────────────────────────────────
// Two modes:
//   1. Reinstall mode — set DD_APP_PATH to a built binary; Appium installs+launches it fresh:
//        DD_APP_PATH=ios/build/Build/Products/Debug-iphonesimulator/mobile.app bun run e2e
//   2. Attach mode (DEFAULT when DD_APP_PATH is empty) — Appium launches the ALREADY-INSTALLED
//      dev-client by bundle id with noReset, so the running Metro binding + dev JS are preserved.
//      This is the fast inner-loop path: rebuild JS via Metro, just relaunch to pick it up.
const APP_PATH = process.env.DD_APP_PATH ?? "";
const BUNDLE_ID = process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard";

// ── iOS Simulator capabilities (default) ─────────────────────────────────────
const IOS_DEVICE = process.env.DD_SIM_DEVICE ?? "iPhone 17 Pro Max";
const IOS_OS = process.env.DD_SIM_OS ?? "26.5";

const iosCap: WebdriverIO.Capabilities = {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:deviceName": IOS_DEVICE,
    "appium:platformVersion": IOS_OS,
    // Reinstall mode pins `app`; attach mode pins `bundleId` + noReset (no uninstall, keep Metro bind).
    ...(APP_PATH ? { "appium:app": APP_PATH } : { "appium:bundleId": BUNDLE_ID, "appium:noReset": true }),
    // New-Arch (D3) dev-client cold-launch can be slow; give WDA room.
    "appium:newCommandTimeout": 240,
    "appium:wdaLaunchTimeout": 120_000,
};

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

const SHOTS_DIR = path.join(import.meta.dirname, "screenshots");

export const config: WebdriverIO.Config = {
    runner: "local",

    // Point the runner at the out-of-band Appium server explicitly. Without hostname/port/path,
    // WDIO v9's session bootstrap builds an invalid connection URL ("TypeError: Invalid URL" at
    // newSession). Override host/port via env when Appium runs elsewhere.
    hostname: process.env.DD_APPIUM_HOST ?? "127.0.0.1",
    port: Number(process.env.DD_APPIUM_PORT ?? "4723"),
    path: "/",

    // Resolve the e2e tsconfig relative to THIS file, not process.cwd() — `bun run e2e` runs
    // from the mobile root, where a bare "./tsconfig.json" would bind to the APP tsconfig
    // (which `exclude`s e2e). tsx loads this config as ESM, so `import.meta.dirname` is set.
    tsConfigPath: path.join(import.meta.dirname, "tsconfig.json"),

    specs: ["./specs/**/*.spec.ts"],
    maxInstances: 1,

    capabilities: [platform === "android" ? androidCap : iosCap],

    logLevel: "info",
    bail: 0,
    waitforTimeout: 10_000,
    connectionRetryTimeout: 120_000,
    connectionRetryCount: 3,

    // The local Appium server is started/managed out-of-band: run `bun run e2e:appium` in a
    // separate shell (default port 4723), then `bun run e2e`. To auto-manage it, add
    // `@wdio/appium-service` to `services` later (kept empty so the runner has no extra deps).
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

        // Force-repoint to a side-port Agent when DD_TEST_AGENT is set. Boot-restore reconnects to
        // the LAST-SAVED connection (e.g. the user's real :3042), so a spec's `if (connectPage.isShown())`
        // pairing guard is false and never re-points — the app keeps talking to the stored Agent. The
        // `pair` deep-link applies UNCONDITIONALLY (upserts + marks active), so injecting it here once
        // per suite pins EVERY spec to the side Agent regardless of stored state. No-op when unset, so
        // default runs are unchanged.
        const testAgent = process.env.DD_TEST_AGENT;
        if (testAgent) {
            const uri = `devdashboard://pair?tier=cloudflared-self&baseUrl=${encodeURIComponent(testAgent)}&username=martin`;
            try {
                await browser.execute("mobile: deepLink", { url: uri, bundleId });
                await browser.pause(3000);
            } catch {
                // A spec's own before() re-pairs too; a failed deep-link here is not fatal.
            }
        }
    },

    // Screenshot every genuinely FAILING test — a captured artifact for each failed assertion, not
    // just a console trace. A skipped/pending test reports `passed === false` too, so it must be
    // excluded (`result.retries.attempts === -1` marks a pending test that never ran); otherwise an
    // all-green run still litters FAIL_*.png for the data-gated `this.skip()` cases. Filename =
    // sanitized "<suite> <test>".
    async afterTest(test, _context, result) {
        const wasSkipped = result.retries != null && result.retries.attempts === -1;
        if (result.passed || wasSkipped) {
            return;
        }

        const safe = `${test.parent} ${test.title}`.replace(/[^a-z0-9]+/gi, "_").slice(0, 120);
        try {
            await browser.saveScreenshot(path.join(SHOTS_DIR, `FAIL_${safe}.png`));
        } catch {
            // A session that already crashed can't screenshot; the spec error itself is the signal.
        }
    },
};
