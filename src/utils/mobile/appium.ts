import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "mobile.appium" });

/**
 * An XCUITest driver older than 12.13.0 shuts the booted simulator down on Xcode 27 (no Simulator.app) and then
 * fails. 12.22.8 is the newest one for Appium 3; driver 13 needs Appium 4.
 */
export const XCUITEST_MIN_FOR_XCODE_27 = "12.13.0";
export const XCUITEST_RECOMMENDED = "12.22.8";

export function appiumHome(): string {
    return env.appium.getHome();
}

/** The installed XCUITest driver version under an Appium home, or null when none is installed there. */
export function xcuitestDriverVersion(home = appiumHome()): string | null {
    const manifest = join(home, "node_modules", "appium-xcuitest-driver", "package.json");

    if (!existsSync(manifest)) {
        return null;
    }

    const parsed = SafeJSON.parse(readFileSync(manifest, "utf8")) as { version?: string };
    return parsed.version ?? null;
}

export function compareVersions(left: string, right: string): number {
    const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);

    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const diff = (a[index] ?? 0) - (b[index] ?? 0);

        if (diff !== 0) {
            return diff;
        }
    }

    return 0;
}

/** Why this driver cannot run on an Xcode with DeviceHub, with the fix command; null when it can. */
export function xcuitestXcodeProblem(version: string | null, usesDeviceHub: boolean): string | null {
    if (!version) {
        return `no XCUITest driver under ${appiumHome()}: appium driver install xcuitest@${XCUITEST_RECOMMENDED}`;
    }

    if (usesDeviceHub && compareVersions(version, XCUITEST_MIN_FOR_XCODE_27) < 0) {
        return (
            `XCUITest driver ${version} predates DeviceHub (needs ${XCUITEST_MIN_FOR_XCODE_27} or newer): ` +
            `appium driver uninstall xcuitest && appium driver install xcuitest@${XCUITEST_RECOMMENDED}`
        );
    }

    return null;
}

/** Whether an Appium server answers on this port. */
export async function appiumReady(port: number): Promise<boolean> {
    const url = `http://127.0.0.1:${port}/status`;

    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        log.debug({ url, status: response.status }, "appium status");
        return response.ok;
    } catch (error) {
        log.debug({ url, error }, "appium not answering");
        return false;
    }
}
