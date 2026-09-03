import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, Storage } from "@genesiscz/utils/storage/storage";
import type { KeepPartnerId } from "./keep-partners";

const log = logger.child({ component: "clones:presets" });
const storage = new Storage("macos-clones");

/** A saved SELECTOR, re-runnable for months. Deliberately holds no keep or
 *  replace paths: those are rediscovered every run, because a branch switch
 *  rewrites `node_modules` under the same directory names. */
export interface Preset {
    id: string;
    dirs: string[];
    worktreesOf?: string;
    targets: string[];
    exclude: string[];
    minReal: number;
    keepPartners: KeepPartnerId[];
    createdAt: string;
    lastRunAt?: string;
    lastReclaimable?: number;
}

export function presetsPath(): string {
    return join(storage.getBaseDir(), "presets.json");
}

export function listPresets(): Preset[] {
    const path = presetsPath();
    if (!existsSync(path)) {
        return [];
    }

    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (err) {
        log.warn({ err, path }, "presets read failed");
        return [];
    }

    const parsed = SafeJSON.parse(raw) as { presets?: Preset[] } | null;
    const presets = parsed?.presets;
    if (!Array.isArray(presets)) {
        log.warn({ path }, "presets file has no presets array");
        return [];
    }

    return [...presets].sort((a, b) => a.id.localeCompare(b.id));
}

function writeAll(presets: Preset[]): void {
    atomicWriteFileSync(presetsPath(), `${SafeJSON.stringify({ presets }, null, 2)}\n`);
}

export function getPreset(id: string): Preset | null {
    return listPresets().find((p) => p.id === id) ?? null;
}

export function savePreset(preset: Preset): void {
    const rest = listPresets().filter((p) => p.id !== preset.id);
    writeAll([...rest, preset].sort((a, b) => a.id.localeCompare(b.id)));
    log.info({ id: preset.id, dirs: preset.dirs, targets: preset.targets }, "preset saved");
}

export function removePreset(id: string): boolean {
    const all = listPresets();
    const rest = all.filter((p) => p.id !== id);
    if (rest.length === all.length) {
        return false;
    }

    writeAll(rest);
    log.info({ id }, "preset removed");
    return true;
}

export function touchPreset(id: string, run: { lastRunAt: string; lastReclaimable: number }): void {
    const existing = getPreset(id);
    if (existing === null) {
        return;
    }

    savePreset({ ...existing, lastRunAt: run.lastRunAt, lastReclaimable: run.lastReclaimable });
}
