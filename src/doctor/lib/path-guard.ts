import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { pathGlobRegex, vmDataReason } from "@genesiscz/utils/rm/rules";

/** System locations no rule removes inside, whatever allow root an analyzer declares. Real paths. */
export const SYSTEM_DENY_PREFIXES = [
    "/System/",
    "/usr/",
    "/bin/",
    "/sbin/",
    "/Library/",
    "/Applications/",
    "/private/etc/",
    "/private/var/db/",
    "/private/var/root/",
    "/cores/",
    "/dev/",
];

export type PathGuardResult = { ok: true; realPaths: string[] } | { ok: false; error: string };

function realOrNull(path: string): string | null {
    try {
        return realpathSync(path);
    } catch {
        return null;
    }
}

function isStrictlyInside(child: string, root: string): boolean {
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return child.startsWith(prefix) && child.length > prefix.length;
}

function hasGitEntry(dir: string): boolean {
    try {
        lstatSync(`${dir}${sep}.git`);
        return true;
    } catch {
        return false;
    }
}

/**
 * An allow root is a folder (the path must sit strictly inside it) or a glob with `*` (the path must be a match, or
 * sit inside one). Plain roots are resolved with `realpath`; a glob is written against real paths.
 */
function insideAllowRoot(real: string, roots: string[]): boolean {
    for (const root of roots) {
        if (!root.includes("*")) {
            if (isStrictlyInside(real, root)) {
                return true;
            }

            continue;
        }

        const regex = pathGlobRegex(root, "");
        let probe = real;

        while (probe.length > 1) {
            if (regex.test(probe)) {
                return true;
            }

            probe = probe.slice(0, probe.lastIndexOf(sep)) || sep;
        }
    }

    return false;
}

/**
 * The `doctor act` path guard, run when a finding is judged and again right before each removal. Every path must
 * exist, be absolute, and must not be a symbolic link: both methods act on what the path names, and Finder's Trash
 * resolves a link to its target, so a link is refused outright rather than half supported. The real path must sit
 * inside one of `allowRoots`, must not be `/`, the home folder, a system location or a git checkout or worktree root,
 * must have at least three components, and must not be a VM disk or sit in a VM data folder.
 */
export function guardPaths(opts: {
    paths: string[];
    allowRoots: string[];
    home: string;
    analyzerId: string;
}): PathGuardResult {
    if (opts.paths.length === 0) {
        return { ok: false, error: "the finding names no paths" };
    }

    const roots = opts.allowRoots
        .map((root) => (root.includes("*") ? root : realOrNull(root)))
        .filter((root): root is string => root !== null);
    const home = realOrNull(opts.home) ?? opts.home;
    const realPaths: string[] = [];

    for (const path of opts.paths) {
        if (!isAbsolute(path)) {
            return { ok: false, error: `${path} is not an absolute path` };
        }

        let isLink = false;
        let isDir = false;

        try {
            const stat = lstatSync(path);
            isLink = stat.isSymbolicLink();
            isDir = stat.isDirectory();
        } catch {
            return { ok: false, error: `${path} does not exist` };
        }

        if (isLink) {
            return {
                ok: false,
                error: `${path} is a symbolic link: doctor act never removes or trashes one, because the Trash would take its target`,
            };
        }

        const real = realOrNull(path);

        if (real === null) {
            return { ok: false, error: `${path} cannot be resolved` };
        }

        if (real === "/" || real === home || real.split(sep).filter(Boolean).length < 3) {
            return { ok: false, error: `${path} resolves to ${real}, which is too shallow to remove` };
        }

        if (SYSTEM_DENY_PREFIXES.some((prefix) => `${real}/`.startsWith(prefix))) {
            return { ok: false, error: `${path} is a system location` };
        }

        if (isDir && hasGitEntry(real)) {
            return { ok: false, error: `${path} is a git checkout or worktree root: remove it through git` };
        }

        const denied = vmDataReason(real, home) ?? vmDataReason(path, opts.home);

        if (denied) {
            return { ok: false, error: `${path}: ${denied}` };
        }

        if (!insideAllowRoot(real, roots)) {
            const where = real === path ? `${path} is` : `${path} resolves to ${real},`;
            return { ok: false, error: `${where} outside the allow roots of ${opts.analyzerId}` };
        }

        realPaths.push(real);
    }

    return { ok: true, realPaths };
}
