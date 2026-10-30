import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, parse, resolve, sep } from "node:path";
import { canonicalDir } from "@genesiscz/utils/fs/canonical";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { GALLERY_DIR, GALLERY_MOUNT } from "./paths";
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

/** Shipped folders the library always shows, even with an empty registry. A registered folder of the same name wins. */
export const BUILTIN_ENTRIES: DashboardEntry[] = [
    { name: GALLERY_MOUNT, dir: GALLERY_DIR, createdAt: "2026-10-15T00:00:00.000Z", entry: "index.tsx" },
];

/**
 * Why `dir` is too broad to serve or register, or null. Every server walks its folder, and the disk root took
 * 8.5 GB and a CPU core for half an hour, so there is no override, not even for an explicit target.
 */
export function tooBroadReason(dir: string, home: string = homedir()): string | null {
    const real = canonicalDir(dir);
    const realHome = canonicalDir(home);
    const { root } = parse(real);

    if (real === root) {
        return "the root of the disk";
    }

    if (dirname(real) === root) {
        return "a top-level folder of the disk";
    }

    if (real === realHome) {
        return "the home folder";
    }

    if (realHome.startsWith(`${real}${sep}`)) {
        return "a folder that contains the home folder";
    }

    return null;
}

export function assertServableDir(dir: string): void {
    const reason = tooBroadReason(dir);

    if (reason) {
        throw new Error(
            `Refusing ${canonicalDir(dir)}: it is ${reason}, and the artifact server walks every file under its folder. Move the artifacts into a folder of their own and serve that.`
        );
    }
}

const warnedEntries = new Set<string>();

/** Why a stored entry is skipped: an empty name cannot be addressed, a too-broad folder must never be walked. */
function unusableReason(entry: DashboardEntry): string | null {
    if (!entry.name?.trim()) {
        return "it has no name";
    }

    return tooBroadReason(entry.dir);
}

export function loadRegistry(): DashboardEntry[] {
    const path = registryPath();

    if (!existsSync(path)) {
        return [];
    }

    const raw = SafeJSON.parse(readFileSync(path, "utf8")) as RegistryFile | null;

    return (raw?.entries ?? []).filter((entry) => {
        const reason = unusableReason(entry);

        if (reason && !warnedEntries.has(`${entry.name}\0${entry.dir}`)) {
            warnedEntries.add(`${entry.name}\0${entry.dir}`);
            logger.warn({ name: entry.name, dir: entry.dir, reason }, "[artifact] skipping a registry entry");
        }

        return !reason;
    });
}

function saveRegistry(entries: DashboardEntry[]): void {
    atomicWriteFileSync(registryPath(), `${SafeJSON.stringify({ entries }, null, 4)}\n`);
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

    assertServableDir(dir);

    if (input.name !== undefined && !input.name.trim()) {
        throw new Error("The registry name is empty. Pass a name with at least one visible character.");
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

    if (!name.trim()) {
        throw new Error(`${dir} gives no registry name. Pass --name.`);
    }

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

/** Serve/open route for a single-file entry: the clean extension-less URL. */
export function entryRoute(entry: string): string {
    return `/${entry.replace(/\.(tsx|jsx|html|md)$/, "")}`;
}

/**
 * `entryRoute` as it goes into a URL: every segment percent-encoded, so a `#` or `?` in a file
 * name stays part of the page path instead of starting a fragment or a query. The catalog
 * decodes each segment again when it resolves the request.
 */
export function entryUrlPath(entry: string): string {
    return entryRoute(entry).split("/").map(encodeURIComponent).join("/");
}

export interface ResolvedTarget {
    dir: string;
    /** Set when the target was a single FILE: its name relative to dir. */
    entry: string | null;
    registryEntry: DashboardEntry | null;
}

/**
 * Resolve a serve/build target: a registered name first, then a built-in one, then a path (a single
 * FILE serves its parent dir with the file as entry — no dedicated folder needed), defaulting to cwd.
 * A folder that is too broad to walk is refused, whichever way it was named.
 */
export function resolveTarget(target: string | undefined): ResolvedTarget {
    const resolved = resolveTargetDir(target);
    assertServableDir(resolved.dir);

    return resolved;
}

function resolveTargetDir(target: string | undefined): ResolvedTarget {
    const entries = loadRegistry();

    if (target) {
        const byName = entries.find((e) => e.name === target) ?? BUILTIN_ENTRIES.find((e) => e.name === target);

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
