import { resolve } from "node:path";
import { Storage } from "@genesiscz/utils/storage/storage";

export interface ClonesConfig {
    watchedDirs: string[];
    minReal?: number;
    exclude?: string[];
    nodeModules?: boolean;
    /** `false` is the opt-out `clones daemon disable` leaves behind. Without a
     *  persisted flag the next finished reclaim plan re-registered both daily
     *  tasks, because "no task exists" is exactly the state disable creates. */
    daemon?: boolean;
}

/** Exported for test fixtures that need to snapshot/restore the entire config
 *  via `storage.getConfig()`/`storage.setConfig()`/`storage.clearConfig()`.
 *  Production callers should use the typed helpers below. */
export const storage = new Storage("macos-clones");

/** Same contract as `--min-real` on the CLI: a positive whole number of
 *  bytes. A config written before this check (or edited by hand) that holds
 *  `-1` reads back as unset, so the daemon falls back to the default instead
 *  of walking and hashing every file. */
function isValidMinReal(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalize(config: Partial<ClonesConfig>): ClonesConfig {
    return {
        watchedDirs: Array.isArray(config.watchedDirs) ? config.watchedDirs : [],
        ...(isValidMinReal(config.minReal) ? { minReal: config.minReal } : {}),
        ...(Array.isArray(config.exclude) ? { exclude: config.exclude } : {}),
        ...(typeof config.nodeModules === "boolean" ? { nodeModules: config.nodeModules } : {}),
        ...(typeof config.daemon === "boolean" ? { daemon: config.daemon } : {}),
    };
}

export async function loadClonesConfig(): Promise<ClonesConfig> {
    const raw = await storage.getConfig<Partial<ClonesConfig>>();
    return normalize(raw ?? {});
}

export async function addWatchedDirs(dirs: string[]): Promise<ClonesConfig> {
    const abs = dirs.map((d) => resolve(d));
    const updated = await storage.atomicConfigUpdate<ClonesConfig>((c) => {
        c.watchedDirs = [...new Set([...(c.watchedDirs ?? []), ...abs])];
    });
    return normalize(updated);
}

export async function removeWatchedDirs(dirs: string[]): Promise<ClonesConfig> {
    const abs = new Set(dirs.map((d) => resolve(d)));
    const updated = await storage.atomicConfigUpdate<ClonesConfig>((c) => {
        c.watchedDirs = (c.watchedDirs ?? []).filter((d) => !abs.has(d));
    });
    return normalize(updated);
}

export async function setMinReal(bytes: number): Promise<ClonesConfig> {
    if (!isValidMinReal(bytes)) {
        throw new RangeError(`minReal must be a positive whole number of bytes, got ${bytes}`);
    }

    const updated = await storage.atomicConfigUpdate<ClonesConfig>((c) => {
        c.minReal = bytes;
    });
    return normalize(updated);
}

export async function setNodeModules(on: boolean): Promise<ClonesConfig> {
    const updated = await storage.atomicConfigUpdate<ClonesConfig>((c) => {
        c.nodeModules = on;
    });
    return normalize(updated);
}

export async function setExclude(globs: string[]): Promise<ClonesConfig> {
    const updated = await storage.atomicConfigUpdate<ClonesConfig>((c) => {
        c.exclude = [...new Set(globs)];
    });
    return normalize(updated);
}

/** Persist the daemon opt-out. `false` makes every later plan skip the daily
 *  task registration; `true` (what `daemon enable` writes) lifts it again. */
export async function setDaemonEnabled(on: boolean): Promise<ClonesConfig> {
    const updated = await storage.atomicConfigUpdate<ClonesConfig>((c) => {
        c.daemon = on;
    });
    return normalize(updated);
}
