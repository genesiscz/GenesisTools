/**
 * Which process owns the client end of a loopback TCP connection.
 *
 * A local HTTP server (the mcp-manager gateway) sees only a peer port. The kernel knows
 * which process holds the socket with that local port, and that answer is exact: one
 * connected socket, one owner (plus any child that inherited the fd, which the caller
 * filters by name). Nothing here guesses from timing.
 *
 * macOS: libproc, the same calls `lsof` makes, without lsof's ~0.23 s start-up cost.
 * Other platforms return null and callers treat the peer as unknown.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "process:socket-owner" });

/** Sizes and offsets from <sys/proc_info.h>; `socket-owner.test.ts` proves them on a live socket. */
const PROC_PIDLISTFDS = 1;
const PROC_FDINFO_SIZE = 8;
const PROX_FDTYPE_SOCKET = 2;
const PROC_PIDFDSOCKETINFO = 3;
const SOCKET_FDINFO_SIZE = 792;
/** `socket_fdinfo.psi` follows the 24-byte `proc_fileinfo`. */
const PSI = 24;
/** `socket_info.soi_kind`, after vinfo_stat (136) and the fixed fields up to the two sockbuf_infos. */
const SOI_KIND_OFFSET = PSI + 232;
const SOCKINFO_TCP = 2;
/** `socket_info.soi_proto.pri_tcp.tcpsi_ini.insi_fport` / `insi_lport`, network byte order in the low 16 bits. */
const INSI_FPORT_OFFSET = PSI + 240;
const INSI_LPORT_OFFSET = PSI + 244;

const PROC_PIDTBSDINFO = 3;
const PROC_PIDTBSDINFO_SIZE = 136;
const PBI_UID_OFFSET = 20;
const PBI_COMM_OFFSET = 48;
const PBI_COMM_SIZE = 16;
const PBI_START_TVSEC_OFFSET = 120;

type LibProc = {
    proc_listallpids: (buffer: unknown, size: number) => number;
    proc_pidinfo: (pid: number, flavor: number, arg: bigint, buffer: unknown, size: number) => number;
    proc_pidfdinfo: (pid: number, fd: number, flavor: number, buffer: unknown, size: number) => number;
};

let libproc: LibProc | null | undefined;

function loadLibproc(): LibProc | null {
    if (libproc !== undefined) {
        return libproc;
    }

    if (process.platform !== "darwin") {
        libproc = null;
        return libproc;
    }

    try {
        const lib = dlopen("libproc.dylib", {
            proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
            proc_pidinfo: {
                args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
                returns: FFIType.i32,
            },
            proc_pidfdinfo: {
                args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32],
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

export interface ProcessInfo {
    pid: number;
    /** `pbi_comm`: the executable name, at most 16 bytes. */
    name: string;
    uid: number;
    /** Process start, seconds since the epoch. */
    startSec: number;
}

/** Name, uid and start time of `pid`, or null when it is gone or unreadable. */
export function readProcessInfo(pid: number): ProcessInfo | null {
    const lib = loadLibproc();
    if (!lib) {
        return null;
    }

    const buffer = new Uint8Array(PROC_PIDTBSDINFO_SIZE);
    if (lib.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, ptr(buffer), PROC_PIDTBSDINFO_SIZE) !== PROC_PIDTBSDINFO_SIZE) {
        return null;
    }

    const view = new DataView(buffer.buffer);
    const commBytes = buffer.subarray(PBI_COMM_OFFSET, PBI_COMM_OFFSET + PBI_COMM_SIZE);
    const end = commBytes.indexOf(0);
    const name = new TextDecoder().decode(end === -1 ? commBytes : commBytes.subarray(0, end));

    return {
        pid,
        name,
        uid: view.getUint32(PBI_UID_OFFSET, true),
        startSec: Number(view.getBigUint64(PBI_START_TVSEC_OFFSET, true)),
    };
}

function listAllPids(lib: LibProc): Int32Array {
    let capacity = 4096;

    while (true) {
        const pids = new Int32Array(capacity);
        const count = lib.proc_listallpids(ptr(pids), pids.byteLength);
        if (count < capacity) {
            return pids.subarray(0, Math.max(0, count));
        }

        capacity *= 2;
    }
}

const fdBuffer = { bytes: new Uint8Array(PROC_FDINFO_SIZE * 512) };
const socketBuffer = new Uint8Array(SOCKET_FDINFO_SIZE);
const socketView = new DataView(socketBuffer.buffer);

/** True when `pid` holds a TCP socket whose local port is `localPort` and foreign port is `foreignPort`. */
function holdsSocket(lib: LibProc, pid: number, localPort: number, foreignPort: number): boolean {
    let written = lib.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, ptr(fdBuffer.bytes), fdBuffer.bytes.byteLength);
    while (written === fdBuffer.bytes.byteLength) {
        fdBuffer.bytes = new Uint8Array(fdBuffer.bytes.byteLength * 2);
        written = lib.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, ptr(fdBuffer.bytes), fdBuffer.bytes.byteLength);
    }

    if (written <= 0) {
        return false;
    }

    const fds = new DataView(fdBuffer.bytes.buffer, 0, written);
    for (let offset = 0; offset + PROC_FDINFO_SIZE <= written; offset += PROC_FDINFO_SIZE) {
        if (fds.getUint32(offset + 4, true) !== PROX_FDTYPE_SOCKET) {
            continue;
        }

        const fd = fds.getInt32(offset, true);
        if (
            lib.proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, ptr(socketBuffer), SOCKET_FDINFO_SIZE) !==
            SOCKET_FDINFO_SIZE
        ) {
            continue;
        }

        if (socketView.getInt32(SOI_KIND_OFFSET, true) !== SOCKINFO_TCP) {
            continue;
        }

        if (
            socketView.getUint16(INSI_LPORT_OFFSET, false) === localPort &&
            socketView.getUint16(INSI_FPORT_OFFSET, false) === foreignPort
        ) {
            return true;
        }
    }

    return false;
}

/** The last answer per client port, re-checked against that one pid before it is trusted again. */
const lastOwner = new Map<string, number>();

/**
 * Every process that holds the client end of the connection from `clientPort` to `serverPort`.
 * Usually one. A child that inherited the descriptor also appears, so callers pick by name.
 * Only processes of this uid are readable, which is the set that can reach a loopback server
 * with this user's token anyway.
 */
export function findLoopbackClientPids(opts: { clientPort: number; serverPort: number }): number[] {
    const lib = loadLibproc();
    if (!lib) {
        return [];
    }

    const key = `${opts.clientPort}:${opts.serverPort}`;
    const cached = lastOwner.get(key);
    if (cached !== undefined && holdsSocket(lib, cached, opts.clientPort, opts.serverPort)) {
        return [cached];
    }

    const ownUid = process.getuid?.() ?? -1;
    const owners: number[] = [];

    for (const pid of listAllPids(lib)) {
        if (pid <= 0) {
            continue;
        }

        const info = readProcessInfo(pid);
        if (!info || info.uid !== ownUid) {
            continue;
        }

        if (holdsSocket(lib, pid, opts.clientPort, opts.serverPort)) {
            owners.push(pid);
        }
    }

    if (owners.length === 1) {
        lastOwner.set(key, owners[0]);
    } else {
        lastOwner.delete(key);
    }

    if (lastOwner.size > 4096) {
        lastOwner.clear();
    }

    return owners;
}
