import { existsSync, realpathSync, statSync } from "node:fs";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { listProcPids, procHeldFiles, readProcProcess } from "./linux-proc";
import { processPlatform } from "./os";

export interface OpenFileHandle {
    pid: number;
    command: string;
    path: string;
}

/**
 * `"unknown"` is not "nothing is open". It means the question could not be answered — no `lsof`
 * on the box, `lsof` complained, or on Linux `/proc` is not readable here (see {@link openFilesFromProc}). A caller
 * deciding whether it is safe to move a file must treat it exactly like a positive hit, never like a clear result.
 */
export type OpenFilesResult = OpenFileHandle[] | "unknown";

export interface OpenFilesQuery {
    /** Exact paths. Paths that do not exist are dropped before the call. */
    files?: string[];
    /** Directories walked recursively (`lsof +D`). Missing directories are dropped. */
    directories?: string[];
    /**
     * Kill `lsof` after this many milliseconds. A kill, a timeout, or any status other than 0 or 1 is
     * `"unknown"`, never an empty list: exit 1 is the normal "nothing is open" answer.
     */
    timeoutMs?: number;
}

function lsofBinary(): string | undefined {
    return Bun.which("lsof") ?? (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : undefined);
}

/**
 * Which processes hold the given files or directory trees open.
 *
 * Modelled on the inspection in `scripts/history/retire-native-cache.ts`: `lsof` exits 1 when any
 * search argument matched nothing, which is the normal case here, so the exit code alone cannot
 * separate "found nothing" from "failed". Anything on stderr means the answer is not trustworthy
 * and the result degrades to `"unknown"`.
 */
export function openFiles(query: OpenFilesQuery): OpenFilesResult {
    const files = (query.files ?? []).filter((path) => existsSync(path));
    const directories = (query.directories ?? []).filter((path) => existsSync(path));

    if (files.length === 0 && directories.length === 0) {
        return [];
    }

    if (processPlatform() === "linux") {
        return openFilesFromProc(files, directories);
    }

    const binary = lsofBinary();

    if (!binary) {
        logger.debug("lsof is unavailable; open-file inspection is unknown");
        return "unknown";
    }

    const args = ["-Fpcn"];

    for (const directory of directories) {
        args.push("+D", directory);
    }
    if (files.length > 0) {
        args.push("--", ...files);
    }

    const child = Bun.spawnSync([binary, ...args], {
        env: env.getProcessEnv(),
        stdout: "pipe",
        stderr: "pipe",
        timeout: query.timeoutMs,
    });
    const stderr = child.stderr.toString().trim();

    // Exit 1 is "nothing matched". A timeout leaves no 0/1 status, and that must stay "unknown".
    if ((child.exitCode !== 0 && child.exitCode !== 1) || stderr) {
        logger.warn({ exitCode: child.exitCode, stderr }, "lsof did not answer cleanly; treating as unknown");
        return "unknown";
    }

    const handles: OpenFileHandle[] = [];
    let pid: number | undefined;
    let command = "";

    for (const line of child.stdout.toString().split("\n")) {
        const value = line.slice(1);

        if (line.startsWith("p")) {
            pid = Number(value);
            command = "";
        } else if (line.startsWith("c")) {
            command = value;
        } else if (line.startsWith("n") && pid !== undefined && Number.isSafeInteger(pid)) {
            handles.push({ pid, command, path: value });
        }
    }

    return handles;
}

/** Pids per path. `"unknown"` stays null: an empty map would read as "nothing is open". */
export function pidsByPath(result: OpenFilesResult): Map<string, number[]> | null {
    if (result === "unknown") {
        return null;
    }

    const open = new Map<string, number[]>();

    for (const handle of result) {
        const pids = open.get(handle.path);

        if (pids) {
            if (!pids.includes(handle.pid)) {
                pids.push(handle.pid);
            }
        } else {
            open.set(handle.path, [handle.pid]);
        }
    }

    return open;
}

/** The pids in `result`, once each. `"unknown"` stays null, as in {@link pidsByPath}. */
export function pidsOf(result: OpenFilesResult): number[] | null {
    if (result === "unknown") {
        return null;
    }

    const pids: number[] = [];

    for (const handle of result) {
        if (!pids.includes(handle.pid)) {
            pids.push(handle.pid);
        }
    }

    return pids;
}

/** The path the kernel shows for an open file: symlinks resolved, as `/proc` links are. */
function realPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** `<st_dev>:<st_ino>` of a file, as {@link procHeldFiles} names a held one; null when it cannot be read. */
function fileId(path: string): string | null {
    try {
        const stat = statSync(path);
        return `${stat.dev}:${stat.ino}`;
    } catch {
        return null;
    }
}

/**
 * Linux with no `lsof` spawned: every readable process's held files ({@link procHeldFiles}). A file asked for matches by
 * device and inode, as `lsof` matches it, so a hard link or a renamed path is still found; a directory tree matches by
 * path, as `lsof +D` walks it. Like `lsof` run as this user, a process whose descriptors are not readable is left out:
 * another user's, one that has gone, and one of this user's that is not dumpable (`ssh-agent`, `gpg-agent`).
 * A `/proc` that cannot answer at all is `"unknown"`, and this process is the proof it is always there: missing from
 * the listing, or its own descriptors unreadable (a restricted `/proc`, a sandbox).
 */
function openFilesFromProc(files: string[], directories: string[]): OpenFilesResult {
    const wanted = new Map<string, string>();

    for (const path of files) {
        const id = fileId(path);

        if (id) {
            wanted.set(id, path);
        }
    }

    const trees = directories.map(realPath);
    const handles: OpenFileHandle[] = [];

    const pids = listProcPids();

    if (!pids.includes(process.pid)) {
        logger.debug("/proc does not list this process; open-file inspection is unknown");
        return "unknown";
    }

    for (const pid of pids) {
        const seen = new Set<string>();
        const held = procHeldFiles(pid);

        if (held === null) {
            if (pid === process.pid) {
                logger.debug("this process's descriptors cannot be read; open-file inspection is unknown");
                return "unknown";
            }

            continue;
        }

        for (const file of held) {
            // A deleted file is no longer in the tree `lsof +D` walks.
            const match =
                (file.id !== null && wanted.has(file.id)) ||
                (!file.path.endsWith(" (deleted)") &&
                    trees.some((tree) => file.path === tree || file.path.startsWith(`${tree}/`)));

            // One handle per file a process holds, however many descriptors and mappings point at it.
            if (match && !seen.has(file.id ?? file.path)) {
                seen.add(file.id ?? file.path);
                handles.push({ pid, command: readProcProcess(pid)?.comm ?? "", path: file.path });
            }
        }
    }

    return handles;
}
