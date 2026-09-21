import { chmodSync, copyFileSync, mkdirSync, readFileSync, type Stats, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { DiffConfig } from "../config";
import { hookDiag } from "../log";

/**
 * The root-based capture only sees files inside a git repository the command WORKS IN: the
 * session cwd, or a directory it `cd`s to. A command that writes to a path it merely NAMES is
 * invisible to it, however ordinary that is. Two measured misses on 2026-09-21, both silent:
 *
 *   bun <script> log "<vault>/<folder>/<note>.md"      (a repo the command never enters)
 *   cd <non-repo dir> && bun <script>                   (no repository at all)
 *
 * The first writes into a real git repository that simply is not a root; the second writes
 * outside git entirely. Neither needs git to be diffable, because the before-state is just a
 * copy of the file. So a named path is watched with a `stat` in the pre phase and a copy, and
 * costs no extra git process in either phase.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MANIFEST = "named.json";
const COPY_DIR = "named";

/** One watched path. `mtimeMs` is absent when the file did not exist when the command began. */
export interface NamedEntry {
    path: string;
    copy?: string;
    mtimeMs?: number;
}

export interface NamedChange {
    path: string;
    /** The before-copy to diff against, or `null` for a file the command created or removed. */
    before: string | null;
    deleted: boolean;
}

export interface NamedCapture {
    entries: NamedEntry[];
    skipped: string[];
}

/**
 * Copies of files the command named, so the post phase has a before-state. They can hold
 * secrets exactly like the root tars, so the tree is 0700 and every copy 0600.
 */
export function captureNamed(dir: string, paths: string[], config: DiffConfig): NamedCapture {
    const entries: NamedEntry[] = [];
    const skipped: string[] = [];
    const existing: { path: string; stat: Stats }[] = [];
    const absent: string[] = [];
    let copies = 0;

    for (const path of paths) {
        try {
            existing.push({ path, stat: statSync(path) });
        } catch {
            absent.push(path);
        }
    }

    // Files that EXIST are taken first. A quoted argument that is really prose (`git commit
    // -m "fix src/a.ts"`) reads as a path-shaped candidate that does not exist, and filling
    // the cap in command order let one of those push a real file out of the window.
    for (const { path, stat } of existing) {
        if (entries.length >= config.maxNamedPaths) {
            skipped.push(`named paths over the ${config.maxNamedPaths} cap`);
            break;
        }

        if (!stat.isFile()) {
            continue;
        }

        if (stat.size > config.maxNamedPathBytes) {
            // Recorded rather than silent: without the copy there is no before-state, so the
            // post phase cannot diff it and the absence must be explainable from the log.
            skipped.push(`${path}: ${stat.size} bytes, over the ${config.maxNamedPathBytes} named-path cap`);
            continue;
        }

        copies += 1;

        const copy = join(COPY_DIR, String(copies));

        try {
            mkdirSync(join(dir, COPY_DIR), { recursive: true, mode: DIR_MODE });
            copyFileSync(path, join(dir, copy));
            chmodSync(join(dir, copy), FILE_MODE);
        } catch (err) {
            hookDiag("Could not copy a named path, so it has no before-state", { err, path });
            continue;
        }

        entries.push({ path, copy, mtimeMs: stat.mtimeMs });
    }

    for (const path of absent) {
        if (entries.length >= config.maxNamedPaths) {
            break;
        }

        // The command names a path that does not exist yet. That is the shape of a file it
        // is about to CREATE, so it is watched with no copy rather than dropped.
        entries.push({ path });
    }

    if (entries.length > 0) {
        try {
            writeFileSync(join(dir, MANIFEST), SafeJSON.stringify(entries), { mode: FILE_MODE });
        } catch (err) {
            hookDiag("Could not write the named-path manifest", { err, dir });
        }
    }

    return { entries, skipped };
}

/**
 * Which watched paths the command actually changed.
 *
 * `mtimeMs` is the test, for the same reason the root collector uses it: a command that
 * rewrites a file with identical content changed nothing a reader needs to see, and the diff
 * that follows is empty anyway, so the block never reaches the output.
 */
function copyOf(dir: string, entry: NamedEntry): string | null {
    return entry.copy ? join(dir, entry.copy) : null;
}

export function namedChanges(dir: string): NamedChange[] {
    const changes: NamedChange[] = [];
    let entries: NamedEntry[];

    try {
        entries = SafeJSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as NamedEntry[];
    } catch {
        // No manifest is the normal case: most commands name no path worth watching.
        return changes;
    }

    if (!Array.isArray(entries)) {
        hookDiag("The named-path manifest is not a list", { dir });
        return changes;
    }

    for (const entry of entries) {
        const existed = entry.mtimeMs !== undefined;
        let stat: Stats | null = null;

        try {
            stat = statSync(entry.path);
        } catch {
            // Gone now. Only interesting when it was there when the command began.
        }

        if (!stat) {
            if (existed) {
                // The copy is kept as the before-state: diffed against `/dev/null` it is
                // what prints the removed lines.
                changes.push({ path: entry.path, before: copyOf(dir, entry), deleted: true });
            }

            continue;
        }

        if (!stat.isFile()) {
            continue;
        }

        if (!existed) {
            changes.push({ path: entry.path, before: null, deleted: false });
            continue;
        }

        if (stat.mtimeMs === entry.mtimeMs) {
            continue;
        }

        changes.push({ path: entry.path, before: copyOf(dir, entry), deleted: false });
    }

    return changes;
}
