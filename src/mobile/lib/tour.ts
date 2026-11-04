import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { appInstalled } from "@genesiscz/utils/mobile/simulator";
import { openScreenDriver, RootMissingError, type ScreenDriverKind } from "./screen-driver";
import type { MobileApp, MobileRoute } from "./types";

const log = logger.child({ component: "mobile.tour" });

export interface TourShot {
    route: MobileRoute;
    file?: string;
    error?: string;
}

/** The routes a command works on: all of them, or the named ones (an unknown name is an error with the list). */
export function selectRoutes(app: MobileApp, appDir: string, only?: string[]): MobileRoute[] {
    const routes = app.routes(appDir).filter((route) => !only?.length || only.includes(route.name));

    if (routes.length === 0) {
        throw new Error(
            `no route matches ${only?.join(", ")}; list them with: ${toolCommand("mobile routes", app.id)}`
        );
    }

    return routes;
}

export async function requireInstalled(app: MobileApp, udid: string, bundleId: string): Promise<void> {
    if (!(await appInstalled(udid, bundleId))) {
        throw new Error(
            `${bundleId} is not installed on ${udid}; build it first: ${toolCommand("mobile build", app.id)}`
        );
    }
}

/**
 * One screenshot per route, named `<NN>-<route>.png`, through the chosen driver. A root that never shows is saved as
 * `<NN>-<route>.MISSING.png`, so the tour always covers every route and says which ones failed.
 */
export async function runTour(options: {
    app: MobileApp;
    appDir: string;
    udid: string;
    outDir: string;
    settleMs: number;
    driver: ScreenDriverKind;
    appiumPort?: number;
    only?: string[];
    onShot?: (shot: TourShot, index: number, total: number) => void;
}): Promise<TourShot[]> {
    const { app, appDir, udid, outDir, settleMs, onShot } = options;
    const bundleId = app.bundleId(appDir);
    await requireInstalled(app, udid, bundleId);
    const routes = selectRoutes(app, appDir, options.only);

    mkdirSync(outDir, { recursive: true });
    log.debug({ app: app.id, udid, driver: options.driver, routes: routes.length, outDir, settleMs }, "tour start");
    const driver = await openScreenDriver(options.driver, { udid, bundleId, settleMs, appiumPort: options.appiumPort });

    const shots: TourShot[] = [];
    try {
        for (const [index, route] of routes.entries()) {
            const file = join(outDir, `${String(index + 1).padStart(2, "0")}-${route.name}.png`);
            let shot: TourShot;

            try {
                await driver.open(route);
                await driver.screenshot(file);
                shot = { route, file };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log.warn({ route: route.name, url: route.url, error: message }, "tour shot failed");

                if (error instanceof RootMissingError) {
                    await driver.screenshot(file.replace(/\.png$/, ".MISSING.png")).catch((shotError: unknown) => {
                        log.debug({ error: shotError }, "no screenshot of the missing screen");
                    });
                }

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
