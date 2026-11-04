import { join } from "node:path";
import {
    type AdbDevice,
    androidProp,
    androidScreenshot,
    avdName,
    forceStop,
    installApk,
    launchPackage,
    listAdbDevices,
    listAvds,
    openAndroidUrl,
    packageInstalled,
    startEmulator,
    stopEmulator,
    uninstallPackage,
} from "@genesiscz/utils/mobile/android";
import { androidApp } from "@genesiscz/utils/mobile/project";
import type { DeviceState, MobileDevice, MobilePlatform } from "./types";

const AVD_PREFIX = "avd:";

function adbState(state: string): DeviceState {
    if (state === "device") {
        return "booted";
    }

    return state === "offline" || state === "unauthorized" ? "offline" : "unknown";
}

/**
 * Every Android target: each device adb lists (an emulator named by its AVD), then each AVD that does not run, as a
 * shut-down `avd:<name>` entry that `boot` can start.
 */
export function mergeAndroidDevices(options: {
    adb: AdbDevice[];
    avds: string[];
    running: Record<string, string | undefined>;
    versions: Record<string, string>;
}): MobileDevice[] {
    const listed: MobileDevice[] = options.adb.map((device) => ({
        platform: "android",
        id: device.serial,
        name: options.running[device.serial] ?? device.model ?? device.serial,
        state: adbState(device.state),
        rawState: device.state,
        osVersion: options.versions[device.serial] ?? "",
        kind: device.emulator ? "emulator" : "device",
    }));
    const runningAvds = new Set(Object.values(options.running).filter(Boolean));
    const idle: MobileDevice[] = options.avds
        .filter((avd) => !runningAvds.has(avd))
        .map((avd) => ({
            platform: "android",
            id: `${AVD_PREFIX}${avd}`,
            name: avd,
            state: "shutdown",
            rawState: "not running",
            osVersion: "",
            kind: "emulator",
        }));
    return [...listed, ...idle];
}

async function listAndroid(): Promise<MobileDevice[]> {
    const devices = await listAdbDevices();
    const ready = devices.filter((device) => device.state === "device");
    const running: Record<string, string | undefined> = {};
    const versions: Record<string, string> = {};

    await Promise.all(
        ready.map(async (device) => {
            versions[device.serial] = await androidProp(device.serial, "ro.build.version.release");

            if (device.emulator) {
                running[device.serial] = await avdName(device.serial);
            }
        })
    );

    return mergeAndroidDevices({ adb: devices, avds: await listAvds(), running, versions });
}

/** Android emulators and devices through adb, AVDs through the SDK's `emulator`. */
export const androidPlatform: MobilePlatform = {
    id: "android",
    title: "Android emulator or device",
    osName: "Android",
    app(project) {
        const android = androidApp(project);
        return {
            id: android.packageName,
            activity: android.activity,
            artifact: android.apk ? join(project.appDir, android.apk) : null,
        };
    },
    listDevices: listAndroid,
    async boot(target, options) {
        const listed = await listAndroid();
        const known = listed.find((device) => device.id === target || device.name === target);

        if (known?.state === "booted") {
            return known;
        }

        const avd = target.startsWith(AVD_PREFIX) ? target.slice(AVD_PREFIX.length) : (known?.name ?? target);

        if (!(await listAvds()).includes(avd)) {
            throw new Error(`no AVD named ${avd}; list them with: emulator -list-avds`);
        }

        const serial = await startEmulator({ avd, timeoutMs: options.timeoutMs });
        const device = (await listAndroid()).find((candidate) => candidate.id === serial);

        if (!device) {
            throw new Error(`the emulator for ${avd} booted as ${serial} but adb does not list it`);
        }

        return device;
    },
    async shutdown(device) {
        if (device.kind !== "emulator") {
            throw new Error(`${device.name} is a physical device; only an emulator can be shut down from here`);
        }

        await stopEmulator(device.id);
    },
    install: (device, artifact) => installApk(device.id, artifact),
    uninstall: (device, app) => uninstallPackage(device.id, app.id),
    isInstalled: (device, app) => packageInstalled(device.id, app.id),
    launch: (device, app) => launchPackage({ serial: device.id, packageName: app.id, activity: app.activity }),
    terminate: (device, app) => forceStop(device.id, app.id),
    openUrl: (device, url, app) => openAndroidUrl({ serial: device.id, url, packageName: app?.id }),
    screenshot: (device, file) => androidScreenshot(device.id, file),
};
