import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
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

/** The device and inode `path` itself names (a symlink names the link), or null when nothing is there. */
export function identityOf(path: string): string | null {
    try {
        const stat = lstatSync(path, { bigint: true });
        return `${stat.dev}:${stat.ino}`;
    } catch {
        return null;
    }
}

/** True when `child` lies strictly inside `parent` (not equal to it). Works with either separator. */
export function isInside(child: string, parent: string): boolean {
    const rel = relative(parent, child);
    return rel !== "" && !isParentStep(rel) && !isAbsolute(rel);
}

/** A relative path that climbs out (`..`, `../x`), not a child whose name starts with dots (`..important`). */
function isParentStep(rel: string): boolean {
    return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\");
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

/**
 * Creates `path` (mode 0700) and proves it is this user's alone: a real folder, not a link, owned by this user and
 * closed to everyone else. With `ancestors`, every folder above it must belong to this user or root and, when others
 * may write to it, be sticky (like /tmp), so no other user can swap it out. Throws otherwise; returns the realpath.
 * Windows has no owner ids here, so it only creates the folder.
 */
export function ensurePrivateDir(path: string, options: { ancestors?: boolean } = {}): string {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const uid = process.getuid?.();

    if (uid === undefined) {
        return realpathSync(path);
    }

    const stat = lstatSync(path);

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`rm: ${path} is not a plain folder`);
    }

    if (stat.uid !== uid) {
        throw new Error(`rm: ${path} belongs to another user (uid ${stat.uid})`);
    }

    if ((stat.mode & 0o077) !== 0) {
        chmodSync(path, 0o700);
    }

    const real = realpathSync(path);

    if (!options.ancestors) {
        return real;
    }

    for (let dir = dirname(real); ; dir = dirname(dir)) {
        const above = statSync(dir);
        const othersWrite = (above.mode & 0o022) !== 0;
        const sticky = (above.mode & 0o1000) !== 0;

        if ((above.uid !== uid && above.uid !== 0) || (othersWrite && !sticky)) {
            throw new Error(`rm: ${dir} (above ${path}) lets another user replace it`);
        }

        if (dirname(dir) === dir) {
            return real;
        }
    }
}
