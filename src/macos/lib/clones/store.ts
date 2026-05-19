import { resolve } from "node:path";
import { Storage } from "@app/utils/storage/storage";

export interface ClonesConfig {
    watchedDirs: string[];
    minReal?: number;
    exclude?: string[];
    nodeModules?: boolean;
}

const storage = new Storage("macos-clones");

function normalize(config: Partial<ClonesConfig>): ClonesConfig {
    return {
        watchedDirs: Array.isArray(config.watchedDirs) ? config.watchedDirs : [],
        ...(typeof config.minReal === "number" ? { minReal: config.minReal } : {}),
        ...(Array.isArray(config.exclude) ? { exclude: config.exclude } : {}),
        ...(typeof config.nodeModules === "boolean" ? { nodeModules: config.nodeModules } : {}),
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
