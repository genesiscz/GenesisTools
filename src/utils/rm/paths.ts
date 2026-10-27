import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The machine-wide temp folder: `/tmp` on macOS and Linux, where the agents' scratch convention and the trash live
 * (macOS's `os.tmpdir()` is a per-user `/var/folders/...` folder, so it is not used there), `os.tmpdir()` on Windows.
 */
export function sharedTempRoot(): string {
    return process.platform === "win32" ? tmpdir() : join(sep, "tmp");
}

/** Where moved-aside items wait for the drain, unless the config names another folder. */
export function defaultTrashRoot(): string {
    return join(sharedTempRoot(), "GenesisTools", "rm");
}

/** The trash folder at the mount point of a volume other than the trash root's, so a move stays a rename. */
export const VOLUME_TRASH_DIR = ".GenesisTools-rm";

/**
 * The realpath of `path`'s parent joined with its own name: a symlink target names the link, not what it points
 * to. A path whose parent does not exist resolves through its deepest existing ancestor.
 */
export function canonicalPath(path: string): string {
    const abs = resolve(path);
    const parent = dirname(abs);

    if (parent === abs) {
        return abs;
    }

    return join(realAncestor(parent), basename(abs));
}

function realAncestor(path: string): string {
    const tail: string[] = [];
    let head = path;

    while (true) {
        try {
            const real = realpathSync(head);
            return tail.length === 0 ? real : join(real, ...tail.reverse());
        } catch {
            const parent = dirname(head);

            if (parent === head) {
                return path;
            }

            tail.push(basename(head));
            head = parent;
        }
    }
}

/** The realpath of an existing folder, or the lexical path when it does not exist yet. */
export function realOrSelf(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

/** True when `child` lies strictly inside `parent` (not equal to it). Works with either separator. */
export function isInside(child: string, parent: string): boolean {
    const rel = relative(parent, child);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function isSameOrInside(child: string, parent: string): boolean {
    return child === parent || isInside(child, parent);
}

export function pathSegments(path: string): string[] {
    return path.split(/[\\/]/).filter(Boolean);
}

/** The folder where the volume holding `path` is mounted: the last ancestor on the same device. */
export function mountPointOf(path: string): string {
    let current = resolve(path);
    const dev = statSync(current).dev;

    while (true) {
        const parent = dirname(current);

        if (parent === current) {
            return current;
        }

        try {
            if (statSync(parent).dev !== dev) {
                return current;
            }
        } catch {
            return current;
        }

        current = parent;
    }
}

/** True for a folder that is a volume's mount point (its device differs from its parent's). */
export function isMountPoint(path: string): boolean {
    const parent = dirname(path);

    if (parent === path) {
        return true;
    }

    try {
        return statSync(path).dev !== statSync(parent).dev;
    } catch {
        return false;
    }
}
