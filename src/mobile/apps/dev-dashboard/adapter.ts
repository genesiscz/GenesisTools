import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MobileApp, MobileRoute } from "@app/mobile/lib/types";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";

const SCHEME = "devdashboard";

/** The expo-router screens of one route group, `_layout` and `+not-found` style files left out. */
function screensIn(dir: string): string[] {
    return readdirSync(dir)
        .filter((file) => file.endsWith(".tsx") && !file.startsWith("_") && !file.startsWith("+"))
        .map((file) => file.replace(/\.tsx$/, ""))
        .sort();
}

/**
 * The DevDashboard mobile app (`DevDashboard/mobile`). Its screens come from the expo-router tree, so a new screen
 * file is in the tour without an edit here: a tab opens as `devdashboard:///<tab>`, a (more) screen as
 * `devdashboard://<route>`, the same links the app's e2e page objects use.
 */
export const devDashboardApp: MobileApp = {
    id: "dev-dashboard",
    title: "DevDashboard mobile",
    locate: () => resolve(moduleDir(import.meta), "../../../../DevDashboard/mobile"),
    bundleId(appDir) {
        const config = SafeJSON.parse(readFileSync(join(appDir, "app.json"), "utf8")) as {
            expo?: { ios?: { bundleIdentifier?: string } };
        };
        const bundleId = config.expo?.ios?.bundleIdentifier;

        if (!bundleId) {
            throw new Error(`${appDir}/app.json has no expo.ios.bundleIdentifier`);
        }

        return bundleId;
    },
    ios: {
        workspace: "ios/DevDashboard.xcworkspace",
        scheme: "DevDashboard",
        configuration: "Release",
        productName: "DevDashboard",
        // ExpoRouter's link preview uses an iOS 16 API, so the Pods' iOS 15 target does not compile in Release.
        buildSettings: { IPHONEOS_DEPLOYMENT_TARGET: "16.0" },
    },
    routes(appDir) {
        const app = join(appDir, "src", "app");
        const tabs = screensIn(join(app, "(tabs)"));
        // The tab bar order is the trigger order in the layout; a tab file the layout does not name goes last.
        const layout = readFileSync(join(app, "(tabs)", "_layout.tsx"), "utf8");
        const triggers = [...layout.matchAll(/Trigger name="([^"]+)"/g)].map((match) => match[1]);
        const ordered = [
            ...triggers.filter((tab) => tabs.includes(tab)),
            ...tabs.filter((tab) => !triggers.includes(tab)),
        ];
        const tabRoutes: MobileRoute[] = ordered.map((tab) => ({
            name: tab === "index" ? "pulse" : tab,
            url: `${SCHEME}:///${tab === "index" ? "" : tab}`,
            rootId: `screen-${tab === "index" ? "pulse" : tab}`,
        }));
        const moreRoutes: MobileRoute[] = screensIn(join(app, "(more)")).map((route) => ({
            name: route,
            url: `${SCHEME}://${route}`,
            rootId: `screen-${route}`,
        }));

        // The root screens outside the groups: the connect gate, and the pairing landing a QR or link opens. A pairing
        // link never connects by itself (the screen waits for a Pair tap), so the tour can show it safely. Only a tunnel or
        // managed tier makes a valid link.
        const rootRoutes: MobileRoute[] = [
            { name: "connect", url: `${SCHEME}://connect`, rootId: "connect-screen" },
            {
                name: "pair",
                url: `${SCHEME}://pair?tier=cloudflared-self&baseUrl=${encodeURIComponent("https://mac.example.com")}&username=demo`,
                rootId: "pair-screen",
            },
        ];

        return [...tabRoutes, ...moreRoutes, ...rootRoutes];
    },
    // An iPhone 17 / 18 Pro: the width the screens are designed at.
    defaultWidth: 402,
    metro: { defaultPort: 8081 },
    buildInputs: {
        native: [
            "app.json",
            "app.config.ts",
            "package.json",
            "patches/*.patch",
            "ios/Podfile",
            "ios/Podfile.lock",
            "ios/Podfile.properties.json",
            "ios/DevDashboard/**/*.{swift,m,mm,h,plist,entitlements}",
            "ios/DevDashboard.xcodeproj/project.pbxproj",
        ],
        js: ["src/**/*.{ts,tsx,js,json}", "assets/**/*", "tailwind.config.js", "babel.config.js", "metro.config.js"],
    },
    firstRun: {
        // The QR scanner asks for the camera, the needs-input alerts for notifications; the LAN discovery's local
        // network prompt has no grant anywhere and is answered by the alert watcher.
        privacy: [],
        idbApprove: ["camera", "notification"],
        scheme: SCHEME,
        defaults: [],
    },
    e2e: {
        config: "e2e/wdio.conf.ts",
        specsDir: "e2e/specs",
        suites: {
            flows: ["pairing.flow", "answer-queue.flow", "agents.flow", "terminal.flow"],
            screens: ["screens.tour"],
        },
        resultsFile: "results.jsonl",
        env: (context) => ({
            DD_SIM_UDID: context.udid,
            DD_SIM_DEVICE: context.deviceName,
            DD_SIM_OS: context.osVersion,
            DD_APPIUM_PORT: String(context.appiumPort),
            DD_WDA_PORT: String(context.wdaPort),
            DD_BUNDLE_ID: context.bundleId,
            DD_RUN_DIR: context.runDir,
            DD_TOUR_DIR: join(context.runDir, "tour"),
            ...(context.agentUrl ? { DD_TEST_AGENT: context.agentUrl } : {}),
        }),
    },
};
