import { existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { env } from "@genesiscz/utils/env";

/**
 * Folders a walk must not enter. Desktop, Documents and Downloads are privacy-protected (listing them can raise a
 * permission prompt) and often iCloud-synced (listing fetches on demand: 8.4 s for one Documents folder, measured
 * 2026-10-14); Library and the media folders never hold checkouts.
 */
const SKIP = new Set([
    "Library",
    "Applications",
    "Desktop",
    "Documents",
    "Downloads",
    "Pictures",
    "Music",
    "Movies",
    "Public",
    "node_modules",
]);
/** A package folder such as `Photos Library.photoslibrary` or `Foo.app`: one document, never a checkout root. */
const PACKAGE = /\.[A-Za-z][A-Za-z0-9]*$/;
/** Enough for any real home; the caps keep a slow or huge tree from stalling a doctor run. */
const MAX_CANDIDATES = 4_000;
const BUDGET_MS = 2_000;

function isRealDir(path: string): boolean {
    try {
        const stat = lstatSync(path);
        return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

function childDirs(dir: string): string[] {
    try {
        return readdirSync(dir)
            .filter((name) => !name.startsWith(".") && !SKIP.has(name) && !PACKAGE.test(name))
            .map((name) => join(dir, name))
            .filter(isRealDir);
    } catch {
        return [];
    }
}

/** Whether one of `dir`'s direct children is a git checkout. */
function holdsCheckouts(dir: string): boolean {
    try {
        return readdirSync(dir).some((name) => !name.startsWith(".") && existsSync(join(dir, name, ".git")));
    } catch {
        return false;
    }
}

/**
 * The folders that hold git checkouts, found under the home folder one and two levels deep: `~/Work` counts when
 * `~/Work/app/.git` exists, `~/Work/clients` when `~/Work/clients/site/.git` does. Nothing is guessed from folder names,
 * so a machine with no checkouts gets no roots. Hidden, protected and package folders and symlinks are not entered,
 * and the walk stops after {@link BUDGET_MS}: a checkout root it did not reach can be named in
 * `GENESIS_TOOLS_DEV_CACHE_ROOTS`.
 */
export function discoverDevRoots(home: string = homedir(), budgetMs: number = BUDGET_MS): string[] {
    const deadline = performance.now() + budgetMs;
    const level1 = childDirs(home);
    const candidates = [...level1];

    for (const dir of level1) {
        if (candidates.length >= MAX_CANDIDATES || performance.now() > deadline) {
            break;
        }

        candidates.push(...childDirs(dir));
    }

    const roots: string[] = [];

    for (const dir of candidates.slice(0, MAX_CANDIDATES)) {
        if (performance.now() > deadline) {
            break;
        }

        if (!existsSync(join(dir, ".git")) && holdsCheckouts(dir)) {
            roots.push(dir);
        }
    }

    return roots;
}

/**
 * The checkout roots `dev-caches` and `temp-leaks` search: the discovered ones plus every root in
 * `GENESIS_TOOLS_DEV_CACHE_ROOTS` (colon separated, `~` allowed), existing ones only, and none inside another.
 */
export function devRoots(home: string = homedir()): string[] {
    const configured = env.doctor.getDevCacheRoots().map((root) => root.replace(/^~/, home));
    const all = [...new Set([...configured, ...discoverDevRoots(home)])].filter((root) => existsSync(root)).sort();
    return all.filter((root) => !all.some((other) => other !== root && root.startsWith(other + sep)));
}
