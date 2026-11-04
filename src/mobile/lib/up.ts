import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type AlertAnswer, AlertWatcher, alertBackendFor } from "@genesiscz/utils/mobile/alerts";
import { appiumPortFor } from "@genesiscz/utils/mobile/appium";
import { type MetroStatus, metroLogPath, readMetroLog, startMetro } from "@genesiscz/utils/mobile/metro";
import {
    appInstalled,
    installApp,
    installedAppInfo,
    launchApp,
    type SimDevice,
    terminateApp,
    wdaPortsFor,
    writeAppDefault,
} from "@genesiscz/utils/mobile/simulator";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { buildAndInstall, builtAppPath } from "./build";
import { buildStaleness, type Staleness } from "./fingerprint";
import { type PreseedReport, preseedFirstRun } from "./first-run";
import { resolveSimulator } from "./simulator-fit";
import type { IosBuild, MobileApp } from "./types";

const log = logger.child({ component: "mobile.up" });

export const BUILD_POLICIES = ["auto", "always", "never"] as const;
export type BuildPolicy = (typeof BUILD_POLICIES)[number];

export interface UpReport {
    device: SimDevice;
    created: boolean;
    booted: boolean;
    configuration: IosBuild["configuration"];
    staleness: Staleness;
    built: boolean;
    buildSeconds?: number;
    appPath: string;
    installed: boolean;
    preseed: PreseedReport;
    metro?: MetroStatus;
    /** Debug: the app fetched its bundle from Metro (or logged) after the launch. */
    appRan?: boolean;
    /** Fatal Metro lines after the launch: the bundle failed or the app crashed at start. */
    fatal: string[];
    alerts: AlertAnswer[];
    appiumPort: number;
    wdaPort: number;
}

interface InstallRecord {
    appPath: string;
    configuration: IosBuild["configuration"];
    /** The modification time of the build's Info.plist when it was installed. */
    builtAt: number;
}

function installRecordPath(udid: string, appId: string): string {
    return toolDataDir("mobile", "installs", `${udid}-${appId}.json`);
}

function buildStamp(appPath: string): number {
    return statSync(join(appPath, "Info.plist")).mtimeMs;
}

/** Whether the simulator already runs this exact build, by the record `up` wrote at its last install. */
function installCurrent(options: { udid: string; app: MobileApp; appPath: string }): boolean {
    const path = installRecordPath(options.udid, options.app.id);

    if (!existsSync(path)) {
        return false;
    }

    const record = SafeJSON.parse(readFileSync(path, "utf8")) as InstallRecord;
    return record.appPath === options.appPath && record.builtAt === buildStamp(options.appPath);
}

function saveInstallRecord(options: {
    udid: string;
    app: MobileApp;
    appPath: string;
    configuration: IosBuild["configuration"];
}): void {
    const path = installRecordPath(options.udid, options.app.id);
    mkdirSync(dirname(path), { recursive: true });
    const record: InstallRecord = {
        appPath: options.appPath,
        configuration: options.configuration,
        builtAt: buildStamp(options.appPath),
    };
    writeFileSync(path, SafeJSON.stringify(record, null, 2));
}

function readSince(path: string, offset: number): string {
    if (!existsSync(path)) {
        return "";
    }

    const text = readFileSync(path, "utf8");
    return text.slice(Math.min(offset, text.length));
}

/**
 * Brings one app up on a simulator sized for a width: find or create and boot the simulator, rebuild when a build
 * input changed, install when the simulator lacks this build, preseed the first-run grants, start Metro for a Debug
 * build and point the app at its port, launch, and answer the system alerts the launch raises.
 */
export async function bringUp(options: {
    app: MobileApp;
    appDir: string;
    udid?: string;
    name?: string;
    width: number;
    os?: string;
    configuration: IosBuild["configuration"];
    derivedData: string;
    build: BuildPolicy;
    metroPort?: number;
    launchTimeoutMs: number;
    onStep?: (message: string) => void;
}): Promise<UpReport> {
    const { app, appDir, configuration, derivedData } = options;
    const step = (message: string) => {
        log.info({ app: app.id }, message);
        options.onStep?.(message);
    };
    const bundleId = app.bundleId(appDir);
    const sim = await resolveSimulator({
        udid: options.udid,
        name: options.name,
        width: options.width,
        os: options.os,
    });
    const { device } = sim;
    step(
        `${sim.created ? "created" : "using"} ${device.name} (${device.udid}, iOS ${device.osVersion})${sim.booted ? ", booted it" : ""}`
    );

    const appPath = builtAppPath(app, derivedData, configuration);
    const staleness = buildStaleness({ app, appDir, derivedData, configuration, appPath });
    const mustBuild = options.build === "always" || (options.build === "auto" && staleness.stale);
    let buildSeconds: number | undefined;

    if (options.build === "never" && !existsSync(appPath)) {
        throw new Error(`--build never, but there is no ${configuration} build at ${appPath}`);
    }

    if (mustBuild) {
        step(
            `building ${configuration} (${staleness.stale ? staleness.reason : "--build always"}); this takes minutes`
        );
        const result = await buildAndInstall({
            app,
            appDir,
            udid: device.udid,
            logDir: toolDataDir("mobile", "builds"),
            install: false,
            derivedData,
            configuration,
        });
        buildSeconds = result.seconds;
        step(`built in ${result.seconds} s`);
    } else {
        step(`build is current (${staleness.reason})`);
    }

    const installed =
        mustBuild ||
        !(await appInstalled(device.udid, bundleId)) ||
        !installCurrent({ udid: device.udid, app, appPath });

    if (installed) {
        await installApp(device.udid, appPath);
        saveInstallRecord({ udid: device.udid, app, appPath, configuration });
        step(`installed ${appPath}`);
    }

    const preseed = await preseedFirstRun({ app, udid: device.udid, bundleId });
    let metro: MetroStatus | undefined;
    let logOffset = 0;

    if (configuration === "Debug" && app.metro) {
        const port = options.metroPort ?? app.metro.defaultPort;
        metro = await startMetro({ port, appDir });
        step(`metro answers on :${port} (log ${metro.log})`);
        // React Native's bundle URL provider reads the packager address from this default before its built-in port.
        await writeAppDefault({ udid: device.udid, bundleId, key: "RCT_jsLocation", value: [`127.0.0.1:${port}`] });
        logOffset = existsSync(metroLogPath(port)) ? statSync(metroLogPath(port)).size : 0;
    }

    await terminateApp(device.udid, bundleId);
    await launchApp(device.udid, bundleId);
    step("launched");

    const wdaPort = wdaPortsFor(device.udid).wda;
    const appName = (await installedAppInfo(device.udid, bundleId))?.displayName ?? "";
    const backend = await alertBackendFor({ udid: device.udid, wdaPort });
    const watcher = backend ? new AlertWatcher({ backend, appName }) : null;
    let appRan: boolean | undefined;
    let fatal: string[] = [];
    const deadline = Date.now() + options.launchTimeoutMs;

    while (Date.now() < deadline) {
        await watcher?.answerNow({ timeoutMs: 2_000, quietMs: 1_000 });

        if (!metro) {
            break;
        }

        const report = readMetroLog(readSince(metro.log, logOffset));
        fatal = report.fatal;

        if (report.ran || fatal.length > 0) {
            appRan = report.ran;
            break;
        }
    }

    if (metro && appRan === undefined) {
        appRan = false;
    }

    return {
        device,
        created: sim.created,
        booted: sim.booted,
        configuration,
        staleness,
        built: mustBuild,
        buildSeconds,
        appPath,
        installed,
        preseed,
        metro,
        appRan,
        fatal,
        alerts: watcher?.answers ?? [],
        appiumPort: appiumPortFor(device.udid),
        wdaPort,
    };
}
