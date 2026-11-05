import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { MobilePlatformId, MobileProject } from "@genesiscz/utils/mobile/project";
import { androidPlatform } from "./android";
import { iosPlatform } from "./ios";
import type { MobileDevice, MobilePlatform } from "./types";

/** One entry per platform a project can name; a missing entry is a compile error. */
export const PLATFORMS: Record<MobilePlatformId, MobilePlatform> = {
    ios: iosPlatform,
    android: androidPlatform,
};

export const PLATFORM_IDS = Object.keys(PLATFORMS) as MobilePlatformId[];

export function isPlatformId(value: string): value is MobilePlatformId {
    return Object.hasOwn(PLATFORMS, value);
}

/**
 * The platform a device command works on: the one asked for, else the project's only platform. A project with two
 * platforms, or no project, needs `--platform`.
 */
export function choosePlatform(requested: string | undefined, project: MobileProject | null): MobilePlatform {
    if (requested) {
        if (!isPlatformId(requested)) {
            throw new Error(`--platform must be ${PLATFORM_IDS.join(" or ")}, not "${requested}"`);
        }

        return PLATFORMS[requested];
    }

    const named = project ? PLATFORM_IDS.filter((id) => project.config.platforms[id]) : [];

    if (named.length === 1) {
        return PLATFORMS[named[0]];
    }

    const why = project ? `${project.configPath} names ${named.join(" and ") || "no platform"}` : "no project config";
    throw new Error(`pass --platform ${PLATFORM_IDS.join("|")} (${why})`);
}

/**
 * The device a command works on. An explicit id (or an Android AVD name) wins; otherwise exactly one booted device of
 * the platform must exist, because picking one of several would drive a device another session is using.
 */
export function chooseDevice(devices: MobileDevice[], requested?: string): MobileDevice {
    if (requested) {
        const byId = devices.find((candidate) => candidate.id === requested);
        const byName = devices.filter((candidate) => candidate.name === requested);

        if (!byId && byName.length > 1) {
            throw new Error(`${byName.length} devices are named ${requested}; pass a device id`);
        }

        const device = byId ?? byName[0];

        if (!device) {
            throw new Error(`no device ${requested}; list them with: ${toolCommand("mobile devices")}`);
        }

        if (device.state !== "booted") {
            throw new Error(`${device.name} (${device.id}) is ${device.rawState}; boot it first`);
        }

        return device;
    }

    const booted = devices.filter((device) => device.state === "booted");

    if (booted.length === 1) {
        return booted[0];
    }

    if (booted.length === 0) {
        throw new Error("no device is booted; boot one or pass --device");
    }

    const names = booted.map((device) => `${device.name} ${device.id}`).join(", ");
    throw new Error(`${booted.length} devices are booted (${names}); pass --device so another session's is not used`);
}
