import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { PidFileState } from "@genesiscz/utils/process/pidfile";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { type DetachedService, serviceState, startDetached, stopDetached } from "./service";
import { udidSlot } from "./simulator";

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

/**
 * The Appium port for one simulator: 4900 to 4999 by the udid's slot, so each simulator gets its own server and a
 * stop of one never ends another session's run. `wdaPortsFor` uses the same hash for the WDA port.
 */
export function appiumPortFor(udid: string): number {
    return 4900 + udidSlot(udid, 100);
}

export interface AppiumStatus {
    port: number;
    answers: boolean;
    version: string | null;
    /** `live` when this tool started the server and it still runs; `none` for a server another process owns. */
    owned: PidFileState["status"];
    pid: number | null;
    log: string;
}

function appiumService(port: number): DetachedService {
    const logPath = toolDataDir("mobile", "appium", `${port}.log`);
    const appium = Bun.which("appium");
    return {
        name: `appium :${port}`,
        // Run from /tmp: from a repo with a hoisted node_modules, Appium resolves its own deps from there and breaks.
        command: [
            ...(appium ? [appium] : ["bunx", "--yes", "appium"]),
            "--port",
            String(port),
            "--log-no-colors",
            "--log-timestamp",
        ],
        cwd: tmpdir(),
        environment: { ...env.getProcessEnv(), APPIUM_HOME: appiumHome() },
        logPath,
        pidPath: toolDataDir("mobile", "appium", `${port}.pid`),
        expect: "appium",
    };
}

export async function appiumStatus(port: number): Promise<AppiumStatus> {
    const service = appiumService(port);
    const state = serviceState(service);
    let version: string | null = null;
    let answers = false;

    try {
        const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2_000) });
        const body = SafeJSON.parse(await response.text(), { strict: true }) as {
            value?: { build?: { version?: string } };
        };
        answers = response.ok;
        version = body.value?.build?.version ?? null;
    } catch (error) {
        log.debug({ port, error }, "appium not answering");
    }

    return {
        port,
        answers,
        version,
        owned: state.status,
        pid: state.status === "live" ? state.pid : null,
        log: service.logPath,
    };
}

/**
 * Starts an Appium server on the port unless one already answers there. Refuses when the XCUITest driver would
 * reboot the simulator on this Xcode (the DeviceHub check), since every session would then fail after a reboot.
 */
export async function startAppium(options: {
    port: number;
    usesDeviceHub: boolean;
    timeoutMs?: number;
}): Promise<AppiumStatus> {
    const current = await appiumStatus(options.port);

    if (current.answers) {
        return current;
    }

    const problem = xcuitestXcodeProblem(xcuitestDriverVersion(), options.usesDeviceHub);

    if (problem) {
        throw new Error(problem);
    }

    await startDetached(appiumService(options.port), {
        ready: () => appiumReady(options.port),
        timeoutMs: options.timeoutMs ?? 120_000,
    });
    return appiumStatus(options.port);
}

/** Stops the server only when this tool started it; a server another process owns is left running. */
export function stopAppium(port: number): Promise<boolean> {
    return stopDetached(appiumService(port));
}
