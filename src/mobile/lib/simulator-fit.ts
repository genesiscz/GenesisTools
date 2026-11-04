import { compareVersions } from "@genesiscz/utils/mobile/appium";
import {
    bootSimulator,
    createSimulator,
    deviceTypeScreen,
    listDeviceTypes,
    listRuntimes,
    listSimulators,
    type SimDevice,
    type SimDeviceType,
    type SimRuntime,
    type SimScreen,
} from "@genesiscz/utils/mobile/simulator";

export interface DeviceTypeFit {
    type: SimDeviceType;
    screen: SimScreen;
}

/** Within a point: a design is 375 or 376 wide for the same 375-point phone. */
export function fitsWidth(screen: SimScreen, width: number): boolean {
    return Math.abs(screen.width - width) <= 1;
}

function modelGeneration(type: SimDeviceType): number {
    const match = type.modelIdentifier?.match(/(\d+),(\d+)/);
    return match ? Number(match[1]) * 100 + Number(match[2]) : 0;
}

/** The iPhone type for a width: the exact width, then the sharper screen, then the newest model. */
export function chooseDeviceType(fits: DeviceTypeFit[], width: number): DeviceTypeFit | null {
    const candidates = fits.filter((fit) => fit.type.productFamily === "iPhone" && fitsWidth(fit.screen, width));
    candidates.sort(
        (a, b) =>
            Math.abs(a.screen.width - width) - Math.abs(b.screen.width - width) ||
            b.screen.scale - a.screen.scale ||
            modelGeneration(b.type) - modelGeneration(a.type)
    );
    return candidates[0] ?? null;
}

/** The newest available iOS runtime that runs this type; `os` narrows it to a version prefix (`26.5`, `27`). */
export function chooseRuntime(runtimes: SimRuntime[], deviceType: string, os?: string): SimRuntime | null {
    const candidates = runtimes.filter(
        (runtime) =>
            runtime.isAvailable &&
            runtime.platform === "iOS" &&
            runtime.supportedDeviceTypes.includes(deviceType) &&
            (!os || runtime.version === os || runtime.version.startsWith(`${os}.`))
    );
    candidates.sort((a, b) => compareVersions(b.version, a.version));
    return candidates[0] ?? null;
}

/** The name `up` gives a simulator it creates for a width, so the next `up` with that width finds it again. */
export function simulatorNameFor(width: number): string {
    return `gt-w${width}`;
}

async function fitsFor(width: number): Promise<DeviceTypeFit[]> {
    const types = (await listDeviceTypes()).filter((type) => type.productFamily === "iPhone");
    const fits = await Promise.all(
        types.map(async (type) => {
            const screen = await deviceTypeScreen(type.bundlePath);
            return screen ? { type, screen } : null;
        })
    );
    return fits.filter((fit): fit is DeviceTypeFit => fit !== null && fitsWidth(fit.screen, width));
}

export interface ResolvedSimulator {
    device: SimDevice;
    created: boolean;
    booted: boolean;
}

/**
 * The simulator `up` works on: the udid asked for, else the one with this name (default `gt-w<width>`), created for the
 * width when it does not exist. Only a simulator named here is ever picked, so `up` never takes over a simulator
 * another session booted. It boots the simulator without opening a simulator UI.
 */
export async function resolveSimulator(options: {
    udid?: string;
    name?: string;
    width: number;
    os?: string;
}): Promise<ResolvedSimulator> {
    const devices = await listSimulators();
    let device = options.udid
        ? devices.find((candidate) => candidate.udid === options.udid)
        : devices.find(
              (candidate) =>
                  candidate.name === (options.name ?? simulatorNameFor(options.width)) && candidate.isAvailable
          );
    let created = false;

    if (options.udid && !device) {
        throw new Error(`no simulator with udid ${options.udid}; list them with: xcrun simctl list devices`);
    }

    if (!device) {
        const fit = chooseDeviceType(await fitsFor(options.width), options.width);

        if (!fit) {
            throw new Error(
                `no iPhone device type is ${options.width} points wide; list them: xcrun simctl list devicetypes`
            );
        }

        const runtime = chooseRuntime(await listRuntimes(), fit.type.identifier, options.os);

        if (!runtime) {
            throw new Error(`no available iOS runtime${options.os ? ` ${options.os}` : ""} runs ${fit.type.name}`);
        }

        const name = options.name ?? simulatorNameFor(options.width);
        const udid = await createSimulator({ name, deviceType: fit.type.identifier, runtime: runtime.identifier });
        created = true;
        device = (await listSimulators()).find((candidate) => candidate.udid === udid);

        if (!device) {
            throw new Error(`simctl created ${udid} but does not list it`);
        }
    }

    const booted = device.state !== "Booted";

    if (booted) {
        await bootSimulator(device.udid);
        device = { ...device, state: "Booted" };
    }

    return { device, created, booted };
}
