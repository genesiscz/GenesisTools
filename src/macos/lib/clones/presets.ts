import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isJsonObject, readJsonFileForUpdateSync } from "@genesiscz/utils/storage/atomic-file";
import { atomicWriteFileSync, Storage } from "@genesiscz/utils/storage/storage";
import type { KeepPartnerId } from "./keep-partners";
import type { ReclaimSelector } from "./reclaim";

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
    rewriteStores?: KeepPartnerId[];
    keepUnfreeable?: boolean;
    createdAt: string;
    lastRunAt?: string;
    lastReclaimable?: number;
    /** Run by the daily scan task, within limits (`tools macos clones reclaim presets auto <id>`). */
    auto?: PresetAuto;
}

/** The guard rails of a plan the scan task runs on its own. */
export interface PresetAuto {
    enabled: boolean;
    /** At most this many bytes of duplicate copies are cloned in one run. */
    maxBytes: number;
    /** At most this many files are cloned in one run. */
    maxFiles: number;
    /** When the scan task first ran this plan as a dry run. Until then it only reports; turning auto on again clears
     *  it, so every new arming starts with a dry run. */
    dryRunAt?: string;
}

/** The selector a preset saves, as `planReclaim` takes it. */
export function selectorFromPreset(preset: Preset): ReclaimSelector {
    return {
        dirs: preset.dirs,
        ...(preset.worktreesOf !== undefined ? { worktreesOf: preset.worktreesOf } : {}),
        targets: preset.targets,
        exclude: preset.exclude,
        minReal: preset.minReal,
        keepPartners: preset.keepPartners,
        ...(preset.rewriteStores !== undefined ? { rewriteStores: preset.rewriteStores } : {}),
        ...(preset.keepUnfreeable === true ? { keepUnfreeable: true } : {}),
    };
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

    // A truncated, empty or merge-conflicted presets.json must not crash every
    // preset verb, or the bad file would be unrepairable from the CLI. The
    // save path reads through presetsForUpdate, which copies it aside first.
    let parsed: { presets?: Preset[] } | null;
    try {
        parsed = SafeJSON.parse(raw) as { presets?: Preset[] } | null;
    } catch (err) {
        log.warn({ err, path }, "presets file is not valid JSON");
        return [];
    }

    const presets = parsed?.presets;
    if (!Array.isArray(presets)) {
        log.warn({ path }, "presets file has no presets array");
        return [];
    }

    return [...presets].sort((a, b) => a.id.localeCompare(b.id));
}

function hasPresetsArray(value: unknown): value is { presets: Preset[] } {
    return isJsonObject(value) && Array.isArray(value.presets);
}

/**
 * The presets a save starts from. A file that exists but does not parse, or has no presets array, is copied to
 * `presets.json.corrupt-<time>` before the save replaces it, so the user's presets survive the rewrite.
 */
function presetsForUpdate(): Preset[] {
    const path = presetsPath();
    const read = readJsonFileForUpdateSync(path, { accepts: hasPresetsArray });

    if (read.state === "corrupt") {
        log.warn({ err: read.error, path, preservedAt: read.preservedAt }, "presets file unreadable; kept a copy");
        return [];
    }

    return read.state === "ok" ? read.value.presets : [];
}

function writeAll(presets: Preset[]): void {
    atomicWriteFileSync(presetsPath(), `${SafeJSON.stringify({ presets }, null, 2)}\n`);
}

export function getPreset(id: string): Preset | null {
    return listPresets().find((p) => p.id === id) ?? null;
}

export function savePreset(preset: Preset): void {
    const rest = presetsForUpdate().filter((p) => p.id !== preset.id);
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

/** Changes one preset's auto settings; null when the preset does not exist. */
export function updatePresetAuto(id: string, auto: PresetAuto | undefined): Preset | null {
    const existing = getPreset(id);
    if (existing === null) {
        return null;
    }

    const { auto: _previous, ...rest } = existing;
    const next: Preset = auto === undefined ? rest : { ...rest, auto };
    savePreset(next);
    log.info({ id, auto }, "preset auto updated");
    return next;
}
