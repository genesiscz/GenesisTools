import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { createGit } from "../git/core";

// The no-delete convention as code: a folder that should go is moved into the day's
// `/tmp/<YYYYMMDD>-agents-removals/<context>` folder, which only this user can enter, and the space
// returns when the machine clears /tmp. `tools hub worktrees move-aside` is the first user.

const log = logger.child({ component: "fs/move-aside" });

const WORKTREE_MOVE_TIMEOUT_MS = 120_000;

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

/** The day's move-aside folder, /tmp/<YYYYMMDD>-agents-removals/<context>, cleared at reboot. */
export function moveAsideRoot({ context, now = new Date() }: { context: string; now?: Date }): string {
    return join("/tmp", `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-agents-removals`, context);
}

/**
 * Makes `path` a folder only this user can enter: created 0700, or an existing one of ours narrowed to 0700.
 * A moved worktree keeps its files' modes, and under /tmp the private home-folder ancestors that kept other
 * local users out are gone, so this folder has to. Returns why it cannot be used, or null.
 */
export function claimPrivateFolder(path: string): string | null {
    try {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        const info = lstatSync(path);

        if (!info.isDirectory()) {
            return `${path} is not a plain folder (a symlink?), so nothing is moved into it`;
        }

        if (process.getuid && info.uid !== process.getuid()) {
            return `${path} belongs to another user, so nothing is moved into it`;
        }

        const above = foreignAncestor(path);

        if (above) {
            return above;
        }

        if ((info.mode & 0o077) !== 0) {
            chmodSync(path, 0o700);
        }

        return null;
    } catch (error) {
        log.warn({ error, path }, "move-aside: the private folder could not be prepared");
        return `${path} could not be prepared as a private folder (${error instanceof Error ? error.message : String(error)}), so nothing is moved into it`;
    }
}

/**
 * Why another local user could swap `path` for a folder of theirs, or null. The folder is only as
 * private as everything above it: a /tmp/<date>-agents-removals planted by someone else lets them rename
 * the claimed folder away and put their own in its place between two moves. So every folder and symlink
 * on the way must be this user's or root's, and a folder others can write needs the sticky bit (as
 * /tmp has), which keeps them from renaming what they do not own.
 */
function foreignAncestor(path: string): string | null {
    const uid = process.getuid?.();

    // No POSIX owners or modes to read (Windows).
    if (uid === undefined) {
        return null;
    }

    const problem = (at: string, info: { uid: number; mode: number }, folder: boolean): string | null => {
        if (info.uid !== uid && info.uid !== 0) {
            return `${at} belongs to another user, who could swap the folder below it, so nothing is moved into ${path}`;
        }

        if (folder && (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) {
            return `${at} can be changed by other users, who could swap the folder below it, so nothing is moved into ${path}`;
        }

        return null;
    };

    // The path as written (a symlinked /tmp, a planted date folder), then the real folders it leads to.
    for (let at = dirname(path); ; at = dirname(at)) {
        const entry = lstatSync(at);
        const found = problem(at, entry, entry.isDirectory());

        if (found) {
            return found;
        }

        if (at === dirname(at)) {
            break;
        }
    }

    for (let at = dirname(realpathSync(path)); ; at = dirname(at)) {
        const found = problem(at, statSync(at), true);

        if (found) {
            return found;
        }

        if (at === dirname(at)) {
            return null;
        }
    }
}

/**
 * Why `parent` is not a real folder directly inside the claimed `root`, or null. A symlink planted there
 * under the repository's name would send the move out of the private folder.
 */
export function claimChildFolder(root: string, parent: string): string | null {
    try {
        mkdirSync(parent, { recursive: true, mode: 0o700 });

        if (!lstatSync(parent).isDirectory() || dirname(realpathSync(parent)) !== realpathSync(root)) {
            return `${parent} is not a plain folder inside ${root} (a symlink?), so nothing is moved into it`;
        }

        return null;
    } catch (error) {
        log.warn({ error, parent }, "move-aside: the repository folder could not be prepared");
        return `${parent} could not be prepared (${error instanceof Error ? error.message : String(error)}), so nothing is moved into it`;
    }
}

/** `git worktree move <from> <to>` in the repository; git refuses a destination that exists. */
export function gitWorktreeMove({ repoRoot, from, to }: { repoRoot: string; from: string; to: string }) {
    return createGit({ cwd: repoRoot }).executor.exec(["worktree", "move", from, to], {
        cwd: repoRoot,
        timeout: WORKTREE_MOVE_TIMEOUT_MS,
    });
}

/** The first of `<base>`, `<base>-2`, `<base>-3`… that does not exist yet. */
export function freeDestination(base: string): string {
    let candidate = base;

    for (let n = 2; existsSync(candidate); n++) {
        candidate = `${base}-${n}`;
    }

    return candidate;
}

/** Same filesystem, so the move is a rename: a move across volumes would copy gigabytes instead. */
export function sameVolume(a: string, b: string): boolean {
    try {
        return statSync(a).dev === statSync(b).dev;
    } catch (err) {
        log.debug({ err, a, b }, "volume check failed; treating as different volumes");
        return false;
    }
}
