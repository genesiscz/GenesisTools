import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type AlertAnswer, AlertWatcher, alertBackendFor } from "@genesiscz/utils/mobile/alerts";
import { appiumPortFor } from "@genesiscz/utils/mobile/appium";
import { type MetroStatus, metroLogPath, readMetroLog, startMetro } from "@genesiscz/utils/mobile/metro";
import { type IosConfiguration, iosApp, type MobileProject } from "@genesiscz/utils/mobile/project";
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

const log = logger.child({ component: "mobile.up" });

export const BUILD_POLICIES = ["auto", "always", "never"] as const;
export type BuildPolicy = (typeof BUILD_POLICIES)[number];

export interface UpReport {
    device: SimDevice;
    created: boolean;
    booted: boolean;
    configuration: IosConfiguration;
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
    configuration: IosConfiguration;
    /** The modification time of the build's Info.plist when it was installed. */
    builtAt: number;
}

function installRecordPath(udid: string, projectId: string): string {
    return toolDataDir("mobile", "installs", `${udid}-${projectId}.json`);
}

function buildStamp(appPath: string): number {
    return statSync(join(appPath, "Info.plist")).mtimeMs;
}

/** Whether the simulator already runs this exact build, by the record `up` wrote at its last install. */
function installCurrent(options: { udid: string; projectId: string; appPath: string }): boolean {
    const path = installRecordPath(options.udid, options.projectId);

    if (!existsSync(path)) {
        return false;
    }

    const record = SafeJSON.parse(readFileSync(path, "utf8")) as InstallRecord;
    return record.appPath === options.appPath && record.builtAt === buildStamp(options.appPath);
}

function saveInstallRecord(options: {
    udid: string;
    projectId: string;
    appPath: string;
    configuration: IosConfiguration;
}): void {
    const path = installRecordPath(options.udid, options.projectId);
    mkdirSync(dirname(path), { recursive: true });
    const record: InstallRecord = {
        appPath: options.appPath,
        configuration: options.configuration,
        builtAt: buildStamp(options.appPath),
    };
    writeFileSync(path, SafeJSON.stringify(record, null, 2));
}

export function readSince(path: string, offset: number): string {
    if (!existsSync(path)) {
        return "";
    }

    const size = statSync(path).size;
    const start = Math.max(size < offset ? 0 : offset, size - 512_000);
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(path, "r");

    try {
        const bytes = readSync(fd, buffer, 0, buffer.length, start);
        return buffer.subarray(0, bytes).toString("utf8");
    } finally {
        closeSync(fd);
    }
}

/**
 * Brings one app up on a simulator sized for a width: find or create and boot the simulator, rebuild when a build
 * input changed, install when the simulator lacks this build, preseed the first-run grants, start Metro for a Debug
 * build and point the app at its port, launch, and answer the system alerts the launch raises.
 */
export async function bringUp(options: {
    project: MobileProject;
    udid?: string;
    name?: string;
    width: number;
    os?: string;
    configuration: IosConfiguration;
    derivedData: string;
    build: BuildPolicy;
    metroPort?: number;
    launchTimeoutMs: number;
    onStep?: (message: string) => void;
}): Promise<UpReport> {
    const { project, configuration, derivedData } = options;
    const { appDir } = project;
    const ios = iosApp(project);
    const projectId = project.config.id;
    const step = (message: string) => {
        log.info({ project: projectId }, message);
        options.onStep?.(message);
    };
    const { bundleId } = ios;
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

    const appPath = builtAppPath(ios, derivedData, configuration);
    const staleness = buildStaleness({ inputs: ios.buildInputs, appDir, derivedData, configuration, appPath });
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
            project,
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
        !installCurrent({ udid: device.udid, projectId, appPath });

    if (installed) {
        await installApp(device.udid, appPath);
        saveInstallRecord({ udid: device.udid, projectId, appPath, configuration });
        step(`installed ${appPath}`);
    }

    const preseed = await preseedFirstRun({ firstRun: ios.firstRun, udid: device.udid, bundleId });
    let metro: MetroStatus | undefined;
    let logOffset = 0;

    if (configuration === "Debug" && project.config.metro) {
        const port = options.metroPort ?? project.config.metro.defaultPort;
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
        if (watcher) {
            await watcher.answerNow({ timeoutMs: Math.min(2_000, Math.max(1, deadline - Date.now())), quietMs: 1_000 });
        } else {
            await Bun.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
        }

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
