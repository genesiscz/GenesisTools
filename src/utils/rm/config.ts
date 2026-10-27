import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { defaultTrashRoot } from "./paths";

/** A folder the user trusts an agent to delete anything inside (the hard-deny rules still apply). */
export interface RmRoot {
    path: string;
    note?: string;
    addedAt: string;
    /** How it was added: `cli` (`tools rm roots add`) or `request:<id>` (an approved agent request). */
    via: string;
}

/**
 * A kind of folder that is safe to delete because a build or an install recreates it. A match needs its name
 * (`*` globs allowed) and, when `markers` is set, one of those files beside it; `parentNames` restricts the
 * folder it may sit in, and `within` makes every child of one fixed folder a match.
 */
export interface RmPreset {
    id: string;
    description: string;
    names: string[];
    markers?: string[];
    parentNames?: string[];
    within?: string;
}

export interface RmConfig {
    roots: RmRoot[];
    /** Extra paths that are never deleted, nor any folder that contains one. */
    protect: string[];
    /** Minutes a moved-aside item waits before the drain deletes it, so `tools rm restore` can bring it back. */
    grace: { presetMinutes: number; otherMinutes: number };
    trashRoot: string;
    disabledPresets: string[];
    customPresets: RmPreset[];
}

export function rmDataDir(...segments: string[]): string {
    return toolDataDir("rm", ...segments);
}

export function rmConfigPath(): string {
    return rmDataDir("config.json");
}

export function defaultRmConfig(): RmConfig {
    return {
        roots: [],
        protect: [],
        grace: { presetMinutes: 0, otherMinutes: 60 },
        trashRoot: defaultTrashRoot(),
        disabledPresets: [],
        customPresets: [],
    };
}

export function loadRmConfig(path = rmConfigPath()): RmConfig {
    if (!existsSync(path)) {
        return defaultRmConfig();
    }

    try {
        return parseRmConfig(SafeJSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
        logger.warn({ path, error }, "rm: config is unreadable, using the defaults");
        return defaultRmConfig();
    }
}

export function saveRmConfig(config: RmConfig, path = rmConfigPath()): void {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${SafeJSON.stringify(config, null, 4)}\n`);
    logger.debug({ path, roots: config.roots.length }, "rm: config saved");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function minutes(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseRoot(value: unknown): RmRoot | null {
    if (!isRecord(value) || typeof value.path !== "string") {
        return null;
    }

    return {
        path: value.path,
        note: typeof value.note === "string" ? value.note : undefined,
        addedAt: typeof value.addedAt === "string" ? value.addedAt : "",
        via: typeof value.via === "string" ? value.via : "cli",
    };
}

function parsePreset(value: unknown): RmPreset | null {
    if (!isRecord(value) || typeof value.id !== "string") {
        return null;
    }

    const names = strings(value.names);

    if (names.length === 0 && typeof value.within !== "string") {
        return null;
    }

    return {
        id: value.id,
        description: typeof value.description === "string" ? value.description : "custom preset",
        names,
        markers: Array.isArray(value.markers) ? strings(value.markers) : undefined,
        parentNames: Array.isArray(value.parentNames) ? strings(value.parentNames) : undefined,
        within: typeof value.within === "string" ? value.within : undefined,
    };
}

/**
 * A trash root must carry a `GenesisTools` folder in its path: the drain deletes everything inside the root, so a
 * root edited to `~` or `/` would turn it into a plain `rm -rf`. Any other value falls back to the default.
 */
export function isTrashRootName(value: unknown): value is string {
    return typeof value === "string" && isAbsolute(value) && /(^|[\\/])GenesisTools([\\/]|$)/.test(value);
}

export function parseRmConfig(raw: unknown): RmConfig {
    const defaults = defaultRmConfig();

    if (!isRecord(raw)) {
        return defaults;
    }

    const grace = isRecord(raw.grace) ? raw.grace : {};

    return {
        roots: Array.isArray(raw.roots) ? raw.roots.map(parseRoot).filter((r): r is RmRoot => r !== null) : [],
        protect: strings(raw.protect),
        grace: {
            presetMinutes: minutes(grace.presetMinutes, defaults.grace.presetMinutes),
            otherMinutes: minutes(grace.otherMinutes, defaults.grace.otherMinutes),
        },
        trashRoot: isTrashRootName(raw.trashRoot) ? raw.trashRoot : defaults.trashRoot,
        disabledPresets: strings(raw.disabledPresets),
        customPresets: Array.isArray(raw.customPresets)
            ? raw.customPresets.map(parsePreset).filter((p): p is RmPreset => p !== null)
            : [],
    };
}
