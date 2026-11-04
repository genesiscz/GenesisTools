import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { appiumReady } from "@genesiscz/utils/mobile/appium";
import {
    appInstalled,
    launchApp,
    openUrl,
    screenshot,
    simulatorUiRunning,
    wdaPortsFor,
} from "@genesiscz/utils/mobile/simulator";
import { AppiumSession } from "@genesiscz/utils/mobile/webdriver";
import type { MobileApp, MobileRoute } from "./types";

const log = logger.child({ component: "mobile.tour" });
const ROOT_TIMEOUT_MS = 15_000;

export interface TourShot {
    route: MobileRoute;
    file?: string;
    error?: string;
}

/** How a tour opens one screen and saves it. One implementation per way of driving the simulator. */
interface TourDriver {
    /** Opens the route and saves the screen; throws when the screen never showed. */
    shoot(route: MobileRoute, file: string): Promise<void>;
    close(): Promise<void>;
}

interface DriverContext {
    udid: string;
    bundleId: string;
    settleMs: number;
    appiumPort: number;
}

export type TourDriverKind = "appium" | "simctl";

/**
 * Appium's `mobile: deepLink` opens the link through XCUITest, so iOS shows no "Open in <app>?" alert, and the driver
 * waits for the screen's root element before the pause. The session pins a WDA port per udid and an `isHeadless` that
 * matches whether a simulator UI is open (Xcode 27 rules: a wrong value reboots the simulator).
 */
async function appiumDriver(context: DriverContext): Promise<TourDriver> {
    if (!(await appiumReady(context.appiumPort))) {
        throw new Error(
            `no Appium on :${context.appiumPort}; start one from /tmp (cd /tmp && appium --port ${context.appiumPort}), ` +
                "pass --appium-port, or use --driver simctl"
        );
    }

    const session = await AppiumSession.create({
        port: context.appiumPort,
        capabilities: {
            platformName: "iOS",
            "appium:automationName": "XCUITest",
            "appium:udid": context.udid,
            "appium:bundleId": context.bundleId,
            "appium:noReset": true,
            "appium:wdaLocalPort": wdaPortsFor(context.udid).wda,
            "appium:isHeadless": !(await simulatorUiRunning()),
            "appium:newCommandTimeout": 240,
            "appium:wdaLaunchTimeout": 120_000,
        },
    });

    return {
        async shoot(route, file) {
            await session.execute("mobile: deepLink", { url: route.url, bundleId: context.bundleId });

            if (route.rootId && !(await session.waitForExist(route.rootId, ROOT_TIMEOUT_MS))) {
                await Bun.write(file.replace(/\.png$/, ".MISSING.png"), await session.screenshot());
                throw new Error(`the screen root ${route.rootId} never showed within ${ROOT_TIMEOUT_MS / 1000} s`);
            }

            await Bun.sleep(context.settleMs);
            const dismissed = await session.dismissAlerts();

            if (dismissed > 0) {
                log.info({ route: route.name, dismissed }, "dismissed system alerts before the screenshot");
            }

            await Bun.write(file, await session.screenshot());
        },
        close: () => session.close(),
    };
}

/**
 * `simctl openurl` plus `simctl io screenshot`: no Appium, no WebDriverAgent. iOS answers each openurl with an
 * "Open in <app>?" alert that stays on screen, so use it only for an app that does not raise it or to check a build.
 */
async function simctlDriver(context: DriverContext): Promise<TourDriver> {
    await launchApp(context.udid, context.bundleId);
    await Bun.sleep(context.settleMs);

    return {
        async shoot(route, file) {
            await openUrl(context.udid, route.url);
            await Bun.sleep(context.settleMs);
            await screenshot(context.udid, file);
        },
        close: async () => {},
    };
}

const DRIVERS: Record<TourDriverKind, (context: DriverContext) => Promise<TourDriver>> = {
    appium: appiumDriver,
    simctl: simctlDriver,
};

export const TOUR_DRIVERS = Object.keys(DRIVERS) as TourDriverKind[];

/** One screenshot per route, named `<NN>-<route>.png`, through the chosen driver. */
export async function runTour(options: {
    app: MobileApp;
    appDir: string;
    udid: string;
    outDir: string;
    settleMs: number;
    driver: TourDriverKind;
    appiumPort: number;
    only?: string[];
    onShot?: (shot: TourShot, index: number, total: number) => void;
}): Promise<TourShot[]> {
    const { app, appDir, udid, outDir, settleMs, only, onShot } = options;
    const bundleId = app.bundleId(appDir);

    if (!(await appInstalled(udid, bundleId))) {
        throw new Error(
            `${bundleId} is not installed on ${udid}; build it first: ${toolCommand("mobile build", app.id)}`
        );
    }

    const routes = app.routes(appDir).filter((route) => !only?.length || only.includes(route.name));

    if (routes.length === 0) {
        throw new Error(
            `no route matches ${only?.join(", ")}; list them with: ${toolCommand("mobile routes", app.id)}`
        );
    }

    mkdirSync(outDir, { recursive: true });
    log.debug({ app: app.id, udid, driver: options.driver, routes: routes.length, outDir, settleMs }, "tour start");
    const driver = await DRIVERS[options.driver]({ udid, bundleId, settleMs, appiumPort: options.appiumPort });

    const shots: TourShot[] = [];
    try {
        for (const [index, route] of routes.entries()) {
            const file = join(outDir, `${String(index + 1).padStart(2, "0")}-${route.name}.png`);
            let shot: TourShot;

            try {
                await driver.shoot(route, file);
                shot = { route, file };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log.warn({ route: route.name, url: route.url, error: message }, "tour shot failed");
                shot = { route, error: message };
            }

            shots.push(shot);
            onShot?.(shot, index, routes.length);
        }
    } finally {
        await driver.close();
    }

    log.debug(
        { shots: shots.filter((shot) => shot.file).length, failed: shots.filter((shot) => shot.error).length },
        "tour done"
    );
    return shots;
}
