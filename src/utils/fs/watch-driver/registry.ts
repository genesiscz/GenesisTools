import type { WatchDriver } from "./types";

/** One row per driver. No driver module loads until `load()` runs. A third driver is one file and one row. */
export interface WatchDriverDefinition {
    load(): Promise<WatchDriver>;
}

export const WATCH_DRIVERS = {
    watchman: { load: () => import("./watchman").then((module) => module.watchmanDriver()) },
    parcel: { load: () => import("./parcel").then((module) => module.parcelDriver()) },
} satisfies Record<string, WatchDriverDefinition>;

export type WatchDriverId = keyof typeof WATCH_DRIVERS;

function isKnownId(value: string): value is WatchDriverId {
    return Object.hasOwn(WATCH_DRIVERS, value);
}

export const WATCH_DRIVER_IDS: readonly WatchDriverId[] = Object.keys(WATCH_DRIVERS).filter(isKnownId);

export function isWatchDriverId(value: string): value is WatchDriverId {
    return isKnownId(value);
}
