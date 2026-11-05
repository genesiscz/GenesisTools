import { iosApp } from "@genesiscz/utils/mobile/project";
import {
    appInstalled,
    bootSimulator,
    installApp,
    launchApp,
    listSimulators,
    openUrl,
    type SimDevice,
    screenshot,
    shutdownSimulator,
    terminateApp,
    uninstallApp,
} from "@genesiscz/utils/mobile/simulator";
import { builtAppPath, defaultDerivedData } from "../build";
import type { MobileDevice, MobilePlatform } from "./types";

export function iosDevice(device: SimDevice): MobileDevice {
    const state = device.state === "Booted" ? "booted" : device.state === "Shutdown" ? "shutdown" : "unknown";
    return {
        platform: "ios",
        id: device.udid,
        name: device.name,
        state,
        rawState: device.state,
        osVersion: device.osVersion,
        kind: "simulator",
    };
}

/** iOS simulators through `simctl`. Physical iPhones are not covered: simctl cannot reach them. */
export const iosPlatform: MobilePlatform = {
    id: "ios",
    title: "iOS simulator",
    osName: "iOS",
    app(project) {
        const ios = iosApp(project);
        return {
            id: ios.bundleId,
            artifact: builtAppPath(ios, defaultDerivedData(project.appDir), ios.build.configuration),
        };
    },
    async listDevices() {
        return (await listSimulators()).filter((device) => device.isAvailable).map(iosDevice);
    },
    async boot(target, options) {
        await bootSimulator(target, options.timeoutMs);
        const device = (await listSimulators()).find((candidate) => candidate.udid === target);

        if (!device) {
            throw new Error(`simctl booted ${target} but does not list it`);
        }

        return iosDevice(device);
    },
    shutdown: (device) => shutdownSimulator(device.id),
    install: (device, artifact) => installApp(device.id, artifact),
    uninstall: (device, app) => uninstallApp(device.id, app.id),
    isInstalled: (device, app) => appInstalled(device.id, app.id),
    launch: (device, app) => launchApp(device.id, app.id),
    terminate: (device, app) => terminateApp(device.id, app.id),
    openUrl: (device, url) => openUrl(device.id, url),
    screenshot: (device, file) => screenshot(device.id, file),
};
