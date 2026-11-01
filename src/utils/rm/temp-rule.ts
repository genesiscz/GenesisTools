import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { liveClaudeSessionIds } from "@genesiscz/utils/claude/peer-message";
import { logger } from "@genesiscz/utils/logger";
import { realOrSelf, sharedTempRoot } from "./paths";

/**
 * The facts the tmp-small rule reads from inside a temp path, from one bounded walk: its size (allocated bytes),
 * every repository in it at any depth, and what makes it not small or not plain.
 */
export interface TempTreeFacts {
    bytes: number;
    /** Over the byte limit, or more entries than the walk reads: not small. */
    over: boolean;
    /** Folders that hold a `.git` (folder or file), at any depth. */
    repos: string[];
    /** Why the tree must stay with the person whatever its size: a socket, a FIFO, a device, an unreadable folder. */
    refuse?: string;
}

/** A small tree has far fewer entries; a walk past this many stops and calls it big. */
const TEMP_TREE_MAX_ENTRIES = 50_000;

/** Walks `path` without following symlinks, stopping as soon as it passes `limitBytes`. */
export function measureTempTree(path: string, limitBytes: number): TempTreeFacts {
    const facts: TempTreeFacts = { bytes: 0, over: false, repos: [] };
    const stack = [path];
    let entries = 0;

    while (stack.length > 0) {
        const next = stack.pop() ?? path;
        let stat: ReturnType<typeof lstatSync>;

        try {
            stat = lstatSync(next);
        } catch (error) {
            logger.debug({ path: next, error }, "rm: tmp-small cannot read an entry");
            return { ...facts, refuse: "an entry it cannot read" };
        }

        if (stat.isSocket() || stat.isFIFO() || stat.isCharacterDevice() || stat.isBlockDevice()) {
            return { ...facts, refuse: stat.isSocket() ? "a socket" : "a pipe or a device" };
        }

        facts.bytes += stat.isSymbolicLink() ? 0 : stat.blocks * 512;
        entries++;

        if (facts.bytes > limitBytes || entries > TEMP_TREE_MAX_ENTRIES) {
            return { ...facts, over: true };
        }

        if (!stat.isDirectory()) {
            continue;
        }

        let names: string[];

        try {
            names = readdirSync(next);
        } catch (error) {
            logger.debug({ path: next, error }, "rm: tmp-small cannot list a folder");
            return { ...facts, refuse: "a folder it cannot list" };
        }

        if (names.includes(".git")) {
            facts.repos.push(next);
        }

        for (const name of names) {
            stack.push(join(next, name));
        }
    }

    return facts;
}

let userTemp: string | null | undefined;

/**
 * The per-user temp folder from `getconf DARWIN_USER_TEMP_DIR` (macOS), read once; null elsewhere or when getconf
 * answers nothing. Never `$TMPDIR`: an agent sets that to anything, and `TMPDIR=~` would make the home folder temp.
 */
export function userTempDir(): string | null {
    if (userTemp !== undefined) {
        return userTemp;
    }

    userTemp = null;

    if (process.platform !== "darwin") {
        return userTemp;
    }

    try {
        const proc = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], { stdout: "pipe", stderr: "pipe" });
        const answer = new TextDecoder().decode(proc.stdout).trim();
        userTemp = proc.exitCode === 0 && answer.startsWith("/") ? realpathSync(answer) : null;
    } catch (error) {
        logger.debug({ error }, "rm: getconf DARWIN_USER_TEMP_DIR failed");
    }

    return userTemp;
}

/** The temp roots the tmp-small rule covers, resolved: the shared `/tmp` and the per-user temp folder. */
export function defaultTempRoots(): string[] {
    const user = userTempDir();
    return [...new Set([realOrSelf(sharedTempRoot()), ...(user ? [user] : [])])];
}

/**
 * Names at the top of a temp root that belong to the system or to a running service, as tmp-reclaim keeps them:
 * launchd and tmux sockets, ssh agents, Claude Code's task output, the GenesisTools state and trash.
 */
const SYSTEM_TEMP_PREFIXES = [
    "com.apple.",
    "launchd",
    "tmux-",
    "ssh-",
    "claude-",
    "cc-socks",
    "powerlog",
    ".X",
    "GenesisTools",
];

export function isSystemTempName(name: string): boolean {
    return SYSTEM_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Anything changed inside within this window counts as a live session's scratch. */
export const SCRATCH_LIVE_HOURS = 12;

/** Whether anything under `dir` changed after `sinceMs`; a tree too big to read in time counts as changed. */
function changedSince(dir: string, sinceMs: number, maxEntries = 20_000): boolean {
    const stack = [dir];
    let entries = 0;

    while (stack.length > 0) {
        const next = stack.pop() ?? dir;
        let stat: ReturnType<typeof lstatSync>;

        try {
            stat = lstatSync(next);
        } catch {
            continue;
        }

        if (Math.max(stat.mtimeMs, stat.ctimeMs) >= sinceMs || ++entries > maxEntries) {
            return true;
        }

        if (stat.isDirectory()) {
            try {
                stack.push(...readdirSync(next).map((name) => join(next, name)));
            } catch (error) {
                logger.debug({ path: next, error }, "rm: cannot list a scratch folder");
                return true;
            }
        }
    }

    return false;
}

export interface ScratchLiveDeps {
    /** The live Claude session ids from the session registry; null when it cannot be read. */
    claudeLive?: () => ReadonlySet<string> | null;
    now?: number;
}

/**
 * Whether `/tmp/<agent dir>/<project>/<token>` belongs to a session that still runs: the Claude registry lists it (the
 * token may be an id prefix of 8 or more characters), the registry cannot be read, or anything inside changed in the
 * last SCRATCH_LIVE_HOURS (Codex and Grok keep no registry). Only a dead session's scratch is plain temp.
 */
export function scratchSessionLive(token: string, dir: string, deps: ScratchLiveDeps = {}): boolean {
    const live = (deps.claudeLive ?? liveClaudeSessionIds)();

    if (live === null) {
        return true;
    }

    const lower = token.toLowerCase();

    for (const id of live) {
        if (id.toLowerCase() === lower || (lower.length >= 8 && id.toLowerCase().startsWith(lower))) {
            return true;
        }
    }

    return changedSince(dir, (deps.now ?? Date.now()) - SCRATCH_LIVE_HOURS * 3_600_000);
}
