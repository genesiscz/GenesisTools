import { AlertWatcher, alertBackendFor } from "./alerts";
import type { MobileRoute } from "./project";
import { attachSession, ensureAppium } from "./session";
import { installedAppInfo, launchApp, openUrl, screenshot as simctlScreenshot, wdaPortsFor } from "./simulator";
import { WdaClient } from "./wda";
import type { AppiumSession } from "./webdriver";

export const ROOT_TIMEOUT_MS = 15_000;

/**
 * How a command opens a screen and reads it back. One implementation per way of driving the simulator; `tour`,
 * `open`, `capture` and `e2e screen` all go through this table.
 */
export interface ScreenDriver {
    readonly kind: ScreenDriverKind;
    /** Opens the route; throws when the screen's root never shows (when the driver can tell). */
    open(route: MobileRoute): Promise<void>;
    screenshot(file: string): Promise<void>;
    /** The accessibility tree as XCUITest XML; null when this driver cannot read it. */
    source(): Promise<string | null>;
    /** The live Appium session, for the commands that tap (`logbox`); null for a driver without one. */
    readonly session: AppiumSession | null;
    close(): Promise<void>;
}

export interface ScreenDriverContext {
    udid: string;
    bundleId: string;
    settleMs: number;
    /** The Appium port; default the simulator's own. */
    appiumPort?: number;
    /** Start an Appium server this tool owns when the port has none. */
    startAppium?: boolean;
}

export type ScreenDriverKind = "appium" | "simctl";

/**
 * Appium's `mobile: deepLink` opens a link through XCUITest, so iOS shows no "Open in <app>?" alert, and the driver
 * waits for the screen's root element before the pause.
 */
async function appiumDriver(context: ScreenDriverContext): Promise<ScreenDriver> {
    const port = await ensureAppium({ udid: context.udid, port: context.appiumPort, start: context.startAppium });
    const session = await attachSession({ udid: context.udid, bundleId: context.bundleId, appiumPort: port });

    return {
        kind: "appium",
        session,
        async open(route) {
            await session.execute("mobile: deepLink", { url: route.url, bundleId: context.bundleId });

            if (route.rootId && !(await session.waitForExist(route.rootId, ROOT_TIMEOUT_MS))) {
                throw new RootMissingError(route, ROOT_TIMEOUT_MS);
            }

            await Bun.sleep(context.settleMs);
            // Preserve permission prompts and app confirmations for capture and inspection.
        },
        async screenshot(file) {
            await Bun.write(file, await session.screenshot());
        },
        source: () => session.source(),
        close: () => session.close(),
    };
}

/**
 * `simctl openurl` plus `simctl io screenshot`: no Appium session. iOS answers each openurl with an "Open in <app>?"
 * alert; the alert watcher taps Open for our app when it can reach the screen (idb, or a WDA another run started),
 * and otherwise the alert stays. It reads the tree only while WDA runs.
 */
async function simctlDriver(context: ScreenDriverContext): Promise<ScreenDriver> {
    const appName = (await installedAppInfo(context.udid, context.bundleId))?.displayName ?? "";
    const wda = new WdaClient(wdaPortsFor(context.udid).wda);
    await launchApp(context.udid, context.bundleId);
    await Bun.sleep(context.settleMs);

    return {
        kind: "simctl",
        session: null,
        async open(route) {
            await openUrl(context.udid, route.url);
            const backend = await alertBackendFor({ udid: context.udid, wdaPort: wda.port });

            if (backend) {
                await new AlertWatcher({ backend, appName }).answerNow({ timeoutMs: 4_000 });
            }

            await Bun.sleep(context.settleMs);
        },
        screenshot: (file) => simctlScreenshot(context.udid, file),
        source: async () => ((await wda.ready()) ? wda.source() : null),
        close: async () => {},
    };
}

const DRIVERS: Record<ScreenDriverKind, (context: ScreenDriverContext) => Promise<ScreenDriver>> = {
    appium: appiumDriver,
    simctl: simctlDriver,
};

export const SCREEN_DRIVERS = Object.keys(DRIVERS) as ScreenDriverKind[];

export function parseScreenDriver(value: string): ScreenDriverKind {
    const kind = SCREEN_DRIVERS.find((candidate) => candidate === value);

    if (!kind) {
        throw new Error(`--driver must be ${SCREEN_DRIVERS.join(" or ")}, not "${value}"`);
    }

    return kind;
}

export function openScreenDriver(kind: ScreenDriverKind, context: ScreenDriverContext): Promise<ScreenDriver> {
    return DRIVERS[kind](context);
}

export class RootMissingError extends Error {
    constructor(
        readonly route: MobileRoute,
        timeoutMs: number
    ) {
        super(`the screen root ${route.rootId} never showed within ${timeoutMs / 1000} s`);
    }
}
