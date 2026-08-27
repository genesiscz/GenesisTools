import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { registryPath } from "./storage";

export interface DashboardEntry {
    name: string;
    dir: string;
    createdAt: string;
    /** Optional default entry file (relative to dir), used by `serve`/`build` when set. */
    entry?: string;
}

interface RegistryFile {
    entries: DashboardEntry[];
}

export function loadRegistry(): DashboardEntry[] {
    const path = registryPath();

    if (!existsSync(path)) {
        return [];
    }

    const raw = SafeJSON.parse(readFileSync(path, "utf8")) as RegistryFile | null;

    return raw?.entries ?? [];
}

function saveRegistry(entries: DashboardEntry[]): void {
    atomicWriteFileSync(registryPath(), `${SafeJSON.stringify({ entries }, null, 4)}\n`);
}

/** Canonicalize a directory path (resolves symlinks, so the same dir never registers twice). */
export function canonicalDir(dir: string): string {
    const abs = resolve(dir);

    return existsSync(abs) ? realpathSync(abs) : abs;
}

export interface AddResult {
    entry: DashboardEntry;
    created: boolean;
}

export function addEntry(input: { dir: string; name?: string; entry?: string }): AddResult {
    const dir = canonicalDir(input.dir);

    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new Error(`Not a directory: ${dir}`);
    }

    const entries = loadRegistry();
    const existing = entries.find((e) => e.dir === dir);

    if (existing) {
        let changed = false;

        if (input.name && input.name !== existing.name) {
            const clash = entries.find((e) => e.name === input.name && e.dir !== dir);

            if (clash) {
                throw new Error(`Name "${input.name}" is already registered for ${clash.dir}.`);
            }

            existing.name = input.name;
            changed = true;
        }

        if (input.entry && input.entry !== existing.entry) {
            existing.entry = input.entry;
            changed = true;
        }

        if (changed) {
            saveRegistry(entries);
        }

        return { entry: existing, created: false };
    }

    const name = input.name ?? uniqueName(basename(dir), entries);
    const clash = entries.find((e) => e.name === name);

    if (clash) {
        throw new Error(`Name "${name}" is already registered for ${clash.dir}. Pass --name to pick another.`);
    }

    const entry: DashboardEntry = {
        name,
        dir,
        createdAt: new Date().toISOString(),
        ...(input.entry ? { entry: input.entry } : {}),
    };
    entries.push(entry);
    saveRegistry(entries);
    // File-only: the CLI prints its own confirmation; info would double-print.
    logger.debug({ name, dir }, "[artifact] registered");

    return { entry, created: true };
}

function uniqueName(base: string, entries: DashboardEntry[]): string {
    if (!entries.some((e) => e.name === base)) {
        return base;
    }

    let n = 2;

    while (entries.some((e) => e.name === `${base}-${n}`)) {
        n++;
    }

    return `${base}-${n}`;
}

export function removeEntry(name: string): DashboardEntry | null {
    const entries = loadRegistry();
    const idx = entries.findIndex((e) => e.name === name);

    if (idx === -1) {
        return null;
    }

    const [removed] = entries.splice(idx, 1);
    saveRegistry(entries);
    logger.debug({ name }, "[artifact] removed");

    return removed;
}

export interface ResolvedTarget {
    dir: string;
    /** Set when the target was a single FILE: its name relative to dir. */
    entry: string | null;
    registryEntry: DashboardEntry | null;
}

/**
 * Resolve a serve/build target: a registered name first, then a path (a single
 * FILE serves its parent dir with the file as entry — no dedicated folder
 * needed), defaulting to cwd.
 */
export function resolveTarget(target: string | undefined): ResolvedTarget {
    const entries = loadRegistry();

    if (target) {
        const byName = entries.find((e) => e.name === target);

        if (byName) {
            return { dir: byName.dir, entry: byName.entry ?? null, registryEntry: byName };
        }

        const abs = resolve(target);

        if (existsSync(abs) && statSync(abs).isFile()) {
            const dir = canonicalDir(resolve(abs, ".."));

            return {
                dir,
                entry: basename(abs),
                registryEntry: entries.find((e) => e.dir === dir) ?? null,
            };
        }

        const dir = canonicalDir(target);

        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
            throw new Error(`"${target}" is neither a registered dashboard name, a file, nor a directory.`);
        }

        return { dir, entry: null, registryEntry: entries.find((e) => e.dir === dir) ?? null };
    }

    const dir = canonicalDir(process.cwd());
    const registryEntry = entries.find((e) => e.dir === dir) ?? null;

    return { dir, entry: registryEntry?.entry ?? null, registryEntry };
}
