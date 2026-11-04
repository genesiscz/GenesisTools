import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { PushDeviceRegistration } from "../../phone-wire";

/** APNs keeps two environments; a TestFlight or App Store build gets production tokens, a debug build sandbox ones. */
export type ApnsEnvironment = "production" | "sandbox";

/** How the Mac reaches one device. The transport is a property of the device (`PUSH_TRANSPORTS`). */
export type PhoneRoute =
    | { kind: "apns"; token: string; environment: ApnsEnvironment }
    | { kind: "simctl"; udid: string };

export type PhoneRouteKind = PhoneRoute["kind"];

export interface PhoneDevice {
    id: string;
    name: string;
    bundleId: string;
    /** The device's box public key (base64); answer tokens are sealed to it. */
    publicKey: string;
    route: PhoneRoute;
    registeredAt: string;
    /** The last registration; a phone registers on every start, so an old date means the app is gone. */
    seenAt: string;
}

export type PhoneDeviceMap = Record<string, PhoneDevice>;

/** The registered devices. The file store is the real one; tests use the memory store. */
export interface PhoneDeviceStore {
    /** Synchronous, so `unusable` (asked on every dispatch) needs no await. */
    list(): PhoneDevice[];
    update<T>(fn: (devices: PhoneDeviceMap) => T): Promise<T>;
}

const DEVICES_FILE = "phone-devices.json";

/** `~/.genesis-tools/notify/cache/phone-devices.json`, owner-only (0600): it names the phones and their tokens. */
export function filePhoneDeviceStore(storage = new Storage("notify")): PhoneDeviceStore {
    return {
        list() {
            const file = join(storage.getCacheDir(), DEVICES_FILE);

            if (!existsSync(file)) {
                return [];
            }

            const map = SafeJSON.parse(readFileSync(file, "utf8"), { strict: true }) as PhoneDeviceMap | null;
            return Object.values(map ?? {});
        },
        async update(fn) {
            let result: ReturnType<typeof fn> | undefined;
            await storage.atomicUpdate<PhoneDeviceMap>(
                DEVICES_FILE,
                (current) => {
                    const devices = { ...(current ?? {}) };
                    result = fn(devices);
                    return devices;
                },
                { mode: 0o600 }
            );
            return result as ReturnType<typeof fn>;
        },
    };
}

export function memoryPhoneDeviceStore(initial: PhoneDeviceMap = {}): PhoneDeviceStore & { devices: PhoneDeviceMap } {
    const devices = initial;
    return {
        devices,
        list: () => Object.values(devices),
        async update(fn) {
            return fn(devices);
        },
    };
}

/** The route a registration names: its APNs token, else its simulator. */
export function routeOf(registration: PushDeviceRegistration, previous?: PhoneRoute): PhoneRoute {
    if (registration.apns) {
        // A token keeps the environment the Mac learned for it (a BadDeviceToken answer flips it once).
        const environment =
            previous?.kind === "apns" && previous.token === registration.apns.token
                ? previous.environment
                : "production";
        return { kind: "apns", token: registration.apns.token, environment };
    }

    if (registration.simulator) {
        return { kind: "simctl", udid: registration.simulator.udid };
    }

    throw new Error("a device registers with an APNs token or a simulator id");
}

/** Adds or refreshes a device; a re-registration keeps its first date. */
export async function registerPhoneDevice(
    store: PhoneDeviceStore,
    registration: PushDeviceRegistration,
    now = new Date()
): Promise<PhoneDevice> {
    return store.update((devices) => {
        const previous = devices[registration.id];
        const device: PhoneDevice = {
            id: registration.id,
            name: registration.name,
            bundleId: registration.bundleId,
            publicKey: registration.publicKey,
            route: routeOf(registration, previous?.route),
            registeredAt: previous?.registeredAt ?? now.toISOString(),
            seenAt: now.toISOString(),
        };
        devices[registration.id] = device;
        return device;
    });
}

export async function removePhoneDevice(store: PhoneDeviceStore, id: string): Promise<boolean> {
    return store.update((devices) => {
        const known = Object.hasOwn(devices, id);
        delete devices[id];
        return known;
    });
}
