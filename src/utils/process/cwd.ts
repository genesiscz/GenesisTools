/**
 * Read the LIVE working directory of a process, including an ancestor's.
 *
 * `process.cwd()` is fixed at spawn time. A long-lived child (an MCP server
 * started with an agent session) therefore reports the directory the session
 * had when the server started, not where the session is now. The agent host
 * itself does chdir, so its cwd is the live answer — but only the kernel knows
 * it, because a process cannot publish its cwd to its children after exec.
 *
 * macOS: libproc, which is what `lsof` itself uses, at ~8µs per call instead of
 * lsof's ~220ms. Linux: the `/proc/<pid>` symlinks. Windows: unsupported, every
 * function returns null and callers keep their own `process.cwd()`.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "process:cwd" });

/** `proc_pidinfo` flavors. Sizes and offsets are from <sys/proc_info.h>. */
const PROC_PIDTBSDINFO = 3;
const PROC_PIDTBSDINFO_SIZE = 136;
/** `struct proc_bsdinfo.pbi_ppid`, after pbi_flags/status/xstatus/pid. */
const PBI_PPID_OFFSET = 16;

const PROC_PIDVNODEPATHINFO = 9;
const PROC_PIDVNODEPATHINFO_SIZE = 2352;
/** `struct vnode_info_path.vip_path`, after the embedded `struct vnode_info`. */
const VIP_PATH_OFFSET = 152;

type LibProc = { proc_pidinfo: (pid: number, flavor: number, arg: bigint, buffer: unknown, size: number) => number };

let libproc: LibProc | null | undefined;

function loadLibproc(): LibProc | null {
    if (libproc !== undefined) {
        return libproc;
    }

    try {
        const lib = dlopen("libproc.dylib", {
            proc_pidinfo: {
                args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
                returns: FFIType.i32,
            },
        });
        libproc = lib.symbols as LibProc;
    } catch (error) {
        log.debug({ error }, "libproc unavailable");
        libproc = null;
    }

    return libproc;
}

function pidInfo(pid: number, flavor: number, size: number): DataView | null {
    const lib = loadLibproc();
    if (!lib) {
        return null;
    }

    const buffer = new Uint8Array(size);
    const written = lib.proc_pidinfo(pid, flavor, 0n, ptr(buffer), size);
    if (written !== size) {
        // 0 means the process is gone or not readable by this uid.
        return null;
    }

    return new DataView(buffer.buffer);
}

function decodeCString(view: DataView, offset: number): string | null {
    let end = offset;
    while (end < view.byteLength && view.getUint8(end) !== 0) {
        end++;
    }

    const bytes = new Uint8Array(view.buffer, offset, end - offset);
    const text = new TextDecoder().decode(bytes);
    return text.length > 0 ? text : null;
}

/** Parent pid of `pid`, or null when unknown (gone, foreign uid, unsupported platform). */
export function readParentPid(pid: number): number | null {
    if (process.platform === "darwin") {
        const info = pidInfo(pid, PROC_PIDTBSDINFO, PROC_PIDTBSDINFO_SIZE);
        return info ? info.getUint32(PBI_PPID_OFFSET, true) : null;
    }

    if (process.platform === "linux") {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            // The comm field is parenthesized and may contain spaces, so fields
            // are counted from the last ')': state, then ppid.
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            const ppid = Number.parseInt(fields[1], 10);
            return Number.isFinite(ppid) ? ppid : null;
        } catch (error) {
            log.debug({ error, pid }, "cannot read /proc stat");
            return null;
        }
    }

    return null;
}

/** Current working directory of `pid` as the kernel sees it right now. */
export function readProcessCwd(pid: number): string | null {
    if (process.platform === "darwin") {
        const info = pidInfo(pid, PROC_PIDVNODEPATHINFO, PROC_PIDVNODEPATHINFO_SIZE);
        return info ? decodeCString(info, VIP_PATH_OFFSET) : null;
    }

    if (process.platform === "linux") {
        try {
            return readlinkSync(`/proc/${pid}/cwd`);
        } catch (error) {
            log.debug({ error, pid }, "cannot read /proc cwd");
            return null;
        }
    }

    return null;
}

export interface AncestorCwdOptions {
    /** Where to start walking. Defaults to this process. */
    startPid?: number;
    /** The cwd to compare against. Defaults to `process.cwd()`. */
    ownCwd?: string;
    /** Walk depth. The agent host sits 1-3 hops above a tool process. */
    maxHops?: number;
}

/**
 * Walk up the parent chain and return the first ancestor whose cwd differs from
 * ours. Wrapper processes inherited our cwd, so the first difference is the
 * process that actually moved: the agent host. Returns null when every ancestor
 * agrees with us, which means nothing moved and `process.cwd()` is already right.
 *
 * The walk stops at the FIRST difference on purpose. Continuing would eventually
 * reach the terminal emulator, whose cwd has nothing to do with the session.
 */
/**
 * The kernel stores a cwd fully resolved, but `process.cwd()` keeps symlinked
 * components. Comparing them raw makes `/tmp/x` and `/private/tmp/x` look like a
 * move that never happened — which both invents an adoption and stops the walk
 * before it can reach an ancestor that really did move.
 */
function resolvedPath(path: string): string {
    try {
        return realpathSync(path);
    } catch (error) {
        log.debug({ error, path }, "cannot resolve path, comparing it as given");
        return path;
    }
}

export function resolveAncestorCwd(options: AncestorCwdOptions = {}): string | null {
    const ownCwd = resolvedPath(options.ownCwd ?? process.cwd());
    const maxHops = options.maxHops ?? 6;
    let pid = options.startPid ?? process.pid;

    for (let hop = 0; hop < maxHops; hop++) {
        const parent = readParentPid(pid);
        if (parent === null || parent <= 1 || parent === pid) {
            return null;
        }

        const cwd = readProcessCwd(parent);
        if (cwd && resolvedPath(cwd) !== ownCwd) {
            return cwd;
        }

        pid = parent;
    }

    return null;
}
