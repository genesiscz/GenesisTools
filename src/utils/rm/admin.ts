import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { formatCount } from "@genesiscz/utils/format";
import { logger } from "@genesiscz/utils/logger";
import { appleScriptString } from "@genesiscz/utils/macos/jxa";
import { shellCommandLine } from "@genesiscz/utils/shell/quote";
import { testProcessReason } from "@genesiscz/utils/test-process";
import { dialogEnvironment } from "./approval";
import type { RmTarget } from "./rules";

/** S_ISVTX: in a sticky folder only an entry's owner, the folder's owner or root may rename or remove the entry. */
const STICKY_BIT = 0o1000;

/** What lstat says about one path, as the move checks read it. */
export interface PathFact {
    uid: number;
    mode: number;
    nlink: number;
    kind: "file" | "dir" | "symlink" | "other";
}

/** The file system reads behind `moveBlock`; a test gives a root-owned file without being root. */
export interface PathFacts {
    /** Null when nothing is there. */
    lstat(path: string): PathFact | null;
    /** This process may create and remove entries in the folder. */
    writable(dir: string): boolean;
    /** The folder with every symlink resolved. */
    realpath(dir: string): string;
}

export const LIVE_PATH_FACTS: PathFacts = {
    lstat: (path) => {
        const stat = lstatSync(path, { throwIfNoEntry: false });

        if (!stat) {
            return null;
        }

        const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
        return { uid: stat.uid, mode: stat.mode, nlink: stat.nlink, kind };
    },
    writable: (dir) => {
        try {
            accessSync(dir, constants.W_OK | constants.X_OK);
            return true;
        } catch (error) {
            logger.debug({ dir, error }, "rm: the folder is not writable by this user");
            return false;
        }
    },
    realpath: (dir) => realpathSync(dir),
};

/**
 * Whether this user can move `target` out of its folder: `free`, `admin` (root's file in a sticky folder such as
 * `/private/var/tmp`: an administrator's password gives it to this user first, on macOS, after a person approved),
 * or `never` (a folder of another user there, a folder this user may not change). POSIX only; root moves anything.
 */
export type MoveBlock = { kind: "free" } | { kind: "admin"; reason: string } | { kind: "never"; reason: string };

export function moveBlock(
    target: Pick<RmTarget, "path" | "kind">,
    options: { uid?: number; platform?: NodeJS.Platform; facts?: PathFacts } = {}
): MoveBlock {
    const uid = options.uid ?? process.getuid?.();
    const facts = options.facts ?? LIVE_PATH_FACTS;

    if (uid === undefined || uid === 0 || target.kind === "missing") {
        return { kind: "free" };
    }

    const folder = dirname(target.path);
    let parent: PathFact | null;
    let item: PathFact | null;
    let realFolder: string;

    try {
        realFolder = facts.realpath(folder);
        parent = facts.lstat(realFolder);
        item = facts.lstat(target.path);
    } catch (error) {
        logger.debug({ path: target.path, error }, "rm: could not read the owner of a path or of its folder");
        return { kind: "free" };
    }

    if (!parent || !item) {
        return { kind: "free" };
    }

    if ((parent.mode & STICKY_BIT) !== 0 && item.uid !== uid && parent.uid !== uid) {
        const owner = item.uid === 0 ? "root" : `user ${item.uid}`;
        const held = `it belongs to ${owner} in the sticky folder ${folder}`;
        const blocker = adminBlocker({ item, realFolder, name: basename(target.path), uid, facts, options });

        if (blocker === null) {
            return {
                kind: "admin",
                reason: `${held}: approving it asks for an administrator's password, which gives it to you so it can move`,
            };
        }

        return { kind: "never", reason: `${held}, so only its owner or root can move it${blocker}` };
    }

    if (!facts.writable(folder)) {
        return {
            kind: "never",
            reason: `this user may not change the folder it is in (${folder}), so it cannot be moved`,
        };
    }

    return { kind: "free" };
}

/**
 * Why an administrator may not hand `item` to this user, as a suffix of the refusal, or null when it may. Only a file
 * with one name or a symlink, never a folder (a recursive chown would follow whatever this user can plant inside),
 * and only when no folder on its real path is one this user could swap: else the password typed for one file could
 * hand over another (a hard link to a system file is refused by its link count for the same reason).
 */
function adminBlocker(input: {
    item: PathFact;
    realFolder: string;
    name: string;
    uid: number;
    facts: PathFacts;
    options: { platform?: NodeJS.Platform };
}): string | null {
    const { item, realFolder, name, uid, facts } = input;

    if (!defaultAdminTakeover(input.options.platform)) {
        return "";
    }

    if (item.kind === "dir" || item.kind === "other") {
        return item.kind === "dir" ? " (a folder: an administrator deletes it, e.g. with sudo)" : "";
    }

    if (item.kind === "file" && item.nlink !== 1) {
        return ` (it has ${formatCount(item.nlink, "name")}: an administrator deletes it, e.g. with sudo)`;
    }

    if (!facts.writable(realFolder)) {
        return "";
    }

    let child = join(realFolder, name);
    let dir = realFolder;

    for (;;) {
        const above = facts.lstat(dir);
        const entry = facts.lstat(child);

        if (!above || !entry) {
            return ` (${dir} could not be read)`;
        }

        const guarded = (above.mode & STICKY_BIT) !== 0 && entry.uid !== uid;
        // Another user's folder lets its owner rename any entry, sticky or not, and a sticky folder lets an entry's owner
        // rename it: neither is root, so either could redirect the later pathname-based chown during the prompt.
        const otherOwner = above.uid !== 0 && above.uid !== uid;
        const otherEntryOwner = child !== join(realFolder, name) && entry.uid !== 0 && entry.uid !== uid;

        if (above.uid === uid || otherOwner || otherEntryOwner || (facts.writable(dir) && !guarded)) {
            return ` (this user could replace ${child}: an administrator deletes it, e.g. with sudo)`;
        }

        if (dirname(dir) === dir) {
            return null;
        }

        child = dir;
        dir = dirname(dir);
    }
}

/** Why `target` needs an administrator to move, or null. */
export function needsAdminReason(target: Pick<RmTarget, "path" | "kind">): string | null {
    const block = moveBlock(target);
    return block.kind === "admin" ? block.reason : null;
}

export interface AdminTakeoverItem {
    path: string;
    /** `dev:ino` of the path as the person approved it, as `identityOf` reads it. */
    identity: string | null;
}

export type AdminTakeoverResult = { ok: true } | { ok: false; reason: string };

/**
 * The step that lets a person-approved move take an item only an administrator can move: it gives the item to this
 * user (owner only, the item itself, never what a symlink names), then the ordinary verified rename moves it.
 */
export interface AdminTakeover {
    /** Why `target` needs an administrator, or null. */
    needed(target: RmTarget): string | null;
    /**
     * Gives `items` (real paths) to this user, with one administrator prompt for all of them. Each item carries the
     * `dev:ino` identity that was approved: the privileged command checks it right before it changes the owner.
     */
    take(items: readonly AdminTakeoverItem[]): AdminTakeoverResult;
}

/** How long the administrator prompt may wait for the person. */
const ADMIN_PROMPT_TIMEOUT_MS = 10 * 60_000;

/**
 * The osascript argv that asks for an administrator's password and gives `items` to `uid`. The shell line changes an
 * owner only while `stat` (no symlink following) still prints the approved `dev:ino`, so a swap during the prompt makes
 * it stop instead of handing over another file.
 */
export function adminTakeoverCommand(items: readonly AdminTakeoverItem[], uid: number): string[] {
    const paths = items.map((item) => item.path);
    const command = items
        .map((item) => {
            const stat = shellCommandLine(["/usr/bin/stat", "-f", "%d:%i", item.path]);
            const expected = shellCommandLine([item.identity ?? "none"]);
            return `[ "$(${stat})" = ${expected} ] && ${shellCommandLine(["/usr/sbin/chown", "-h", String(uid), item.path])}`;
        })
        .join(" && ");
    const what = paths.length === 1 ? (paths[0] ?? "") : formatCount(paths.length, "file");
    const prompt = `GenesisTools moves ${what} to its trash. Only root may move it: enter an administrator's password to give it to you first.`;
    return [
        "/usr/bin/osascript",
        "-e",
        `do shell script ${appleScriptString(command)} with prompt ${appleScriptString(prompt)} with administrator privileges`,
    ];
}

/** macOS: `chown -h` through `do shell script ... with administrator privileges`, the system's admin prompt. */
export const MAC_ADMIN_TAKEOVER: AdminTakeover = {
    needed: (target) => needsAdminReason(target),
    take: (items) => {
        const paths = items.map((item) => item.path);
        const inTest = testProcessReason();

        // A data-loss guard, as the trash's: a test never asks the person for a password or changes an owner.
        if (inTest) {
            return { ok: false, reason: `a test process never asks for an administrator's password (${inTest})` };
        }

        const uid = process.getuid?.();

        if (uid === undefined) {
            return { ok: false, reason: "this system has no user ids" };
        }

        const argv = adminTakeoverCommand(items, uid);
        logger.info({ paths }, "rm: asking for an administrator's password to give root's files to this user");
        const proc = Bun.spawnSync(argv, {
            env: dialogEnvironment("/usr/bin:/bin"),
            stdout: "pipe",
            stderr: "pipe",
            timeout: ADMIN_PROMPT_TIMEOUT_MS,
        });

        if (proc.exitCode === 0) {
            return { ok: true };
        }

        const stderr = new TextDecoder().decode(proc.stderr).trim();
        logger.warn({ paths, exitCode: proc.exitCode, stderr }, "rm: the administrator step did not run");
        return {
            ok: false,
            reason: /-128/.test(stderr)
                ? "the administrator's password was not given"
                : `the administrator step failed (${stderr || `exit ${proc.exitCode}`})`,
        };
    },
};

/** The administrator step of each platform that has one; elsewhere such an item stays `not-movable`. */
const ADMIN_TAKEOVERS: Partial<Record<NodeJS.Platform, AdminTakeover>> = { darwin: MAC_ADMIN_TAKEOVER };

/** The administrator step this platform has, or null (a move of such an item is then refused). */
export function defaultAdminTakeover(platform: NodeJS.Platform = process.platform): AdminTakeover | null {
    return ADMIN_TAKEOVERS[platform] ?? null;
}
