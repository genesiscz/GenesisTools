/**
 * A process's physical footprint: the memory macOS charges it (Activity Monitor's "Memory", `footprint`,
 * `vmmap --summary`). RSS is the wrong number for a long-lived bun process on macOS: memory the allocator
 * gave back with MADV_FREE stays in RSS until the system needs it. Measured 2026-10-01 on the resident hub
 * server: RSS 452 MB, physical footprint 59.5 MB, 337 MB "reclaimable".
 *
 * macOS: `proc_pid_rusage(pid, RUSAGE_INFO_V2)`, field `ri_phys_footprint`. Elsewhere, or when the call
 * fails: null, and the caller falls back to RSS.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { logger } from "@genesiscz/utils/logger";

const RUSAGE_INFO_V2 = 2;
/** `struct rusage_info_v2`: uuid[16], then u64 user_time, system_time, pkg_idle_wkups, interrupt_wkups,
 *  pageins, wired_size, resident_size, phys_footprint. */
const PHYS_FOOTPRINT_OFFSET = 16 + 7 * 8;
const BUFFER_BYTES = 512;

type ProcRusage = (pid: number, flavor: number, buffer: unknown) => number;

let procPidRusage: ProcRusage | null | undefined;

function load(): ProcRusage | null {
    if (procPidRusage !== undefined) {
        return procPidRusage;
    }

    procPidRusage = null;
    if (process.platform !== "darwin") {
        return procPidRusage;
    }

    try {
        const lib = dlopen("libproc.dylib", {
            proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
        });
        procPidRusage = lib.symbols.proc_pid_rusage as ProcRusage;
    } catch (error) {
        logger.debug({ error }, "proc_pid_rusage unavailable; footprint falls back to RSS");
    }

    return procPidRusage;
}

/** Bytes, or null when the platform or the call cannot answer. */
export function physFootprintBytes(pid: number = process.pid): number | null {
    const rusage = load();
    if (!rusage) {
        return null;
    }

    const buffer = new BigUint64Array(BUFFER_BYTES / 8);
    if (rusage(pid, RUSAGE_INFO_V2, ptr(buffer)) !== 0) {
        return null;
    }

    return Number(buffer[PHYS_FOOTPRINT_OFFSET / 8]);
}
