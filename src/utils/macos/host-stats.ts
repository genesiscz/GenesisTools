/**
 * CPU, memory and swap figures of this Mac, read from the kernel through libSystem instead of spawning `top`,
 * `vm_stat`, `sysctl` and `memory_pressure`.
 *
 * Measured on 2026-10-12: `top -l 1 -n 0` costs about 2.0 s of CPU per run (the dev-dashboard pulse ran it once a
 * minute idle, every 5 s with a tab open), `vm_stat`, `sysctl` and `memory_pressure` about 2.5 ms each. These reads
 * cost microseconds. Every reader answers null off macOS or when the call fails, and the caller keeps its spawn.
 *
 * Constants, sizes and offsets are from the macOS SDK headers (`mach/host_info.h`, `mach/vm_statistics.h`,
 * `sys/sysctl.h`), checked with `offsetof` / `sizeof` in a C program on 2026-10-12 (Darwin 25.3, arm64).
 */
import { libSystem } from "@genesiscz/utils/fs/native/libsystem";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("host-stats");

/** `HOST_CPU_LOAD_INFO`, whose `cpu_ticks[CPU_STATE_MAX]` are four `natural_t`: user, system, idle, nice. */
const HOST_CPU_LOAD_INFO = 3;
const HOST_CPU_LOAD_INFO_COUNT = 4;
/** `HOST_VM_INFO64` and the size of `vm_statistics64_data_t` in `integer_t` words (248 bytes). */
const HOST_VM_INFO64 = 4;
const HOST_VM_INFO64_COUNT = 62;
/** `vm_statistics64` word indexes (byte offset / 4): every count here is a 32-bit `natural_t`. */
const VM_FREE = 0;
const VM_ACTIVE = 1;
const VM_INACTIVE = 2;
const VM_WIRE = 3;
const VM_PURGEABLE = 22;
const VM_SPECULATIVE = 23;
const VM_COMPRESSOR = 32;
const VM_THROTTLED = 33;
/** The kernel may answer a shorter `vm_statistics64` than the SDK's; it must reach `compressor_page_count`. */
const VM_MIN_WORDS = VM_COMPRESSOR + 1;
/** `struct xsw_usage`: u64 total, avail, used, then u32 pagesize and `boolean_t` encrypted (32 bytes). */
const XSW_USAGE_BYTES = 32;

const KERN_SUCCESS = 0;

export interface CpuTicks {
    user: number;
    system: number;
    idle: number;
    nice: number;
}

/** Page counts as `vm_stat` prints them. `free` excludes speculative pages, exactly as `vm_stat`'s "Pages free". */
export interface VmPageCounts {
    pageSize: number;
    free: number;
    active: number;
    inactive: number;
    speculative: number;
    throttled: number;
    wired: number;
    purgeable: number;
    compressed: number;
}

export interface SwapUsage {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    encrypted: boolean;
}

let hostPort: number | null = null;
const cpuWords = new Uint32Array(HOST_CPU_LOAD_INFO_COUNT);
const vmWords = new Uint32Array(HOST_VM_INFO64_COUNT);
const countWord = new Uint32Array(1);
const sysctlWords = new Uint32Array(XSW_USAGE_BYTES / 4);
const sysctlSize = new BigUint64Array(1);
const sysctlNames = new Map<string, Buffer>();

function calls() {
    const symbols = libSystem();

    if (symbols && hostPort === null) {
        hostPort = symbols.mach_host_self();
    }

    return symbols;
}

/** True when the kernel reads here can answer: macOS with libSystem loaded. */
export function hostStatsAvailable(): boolean {
    return calls() !== null;
}

/**
 * One `sysctlbyname` into the shared word buffer. Returns the number of bytes the kernel wrote, or null when the
 * call failed (logged with the name, so a renamed key shows up in the day log).
 */
function sysctlWordsOf(name: string, bytes: number): number | null {
    const symbols = calls();

    if (!symbols) {
        return null;
    }

    let cName = sysctlNames.get(name);

    if (!cName) {
        cName = Buffer.from(`${name}\0`);
        sysctlNames.set(name, cName);
    }

    sysctlWords.fill(0);
    sysctlSize[0] = BigInt(bytes);

    if (symbols.sysctlbyname(cName, sysctlWords, sysctlSize, null, 0) !== 0) {
        log.debug({ name }, "sysctlbyname failed");
        return null;
    }

    return Number(sysctlSize[0]);
}

/** An integer sysctl of 4 or 8 bytes (`hw.memsize`, `hw.pagesize`, `kern.memorystatus_level`). */
function sysctlInteger(name: string): number | null {
    const written = sysctlWordsOf(name, 8);

    if (written === 4) {
        return sysctlWords[0];
    }

    if (written === 8) {
        return sysctlWords[0] + sysctlWords[1] * 2 ** 32;
    }

    if (written !== null) {
        log.debug({ name, written }, "sysctl answered an unexpected size");
    }

    return null;
}

/** Cumulative CPU ticks of all cores since boot (`host_statistics(HOST_CPU_LOAD_INFO)`). */
export function readCpuTicks(): CpuTicks | null {
    const symbols = calls();

    if (!symbols || hostPort === null) {
        return null;
    }

    countWord[0] = HOST_CPU_LOAD_INFO_COUNT;
    const result = symbols.host_statistics(hostPort, HOST_CPU_LOAD_INFO, cpuWords, countWord);

    if (result !== KERN_SUCCESS || countWord[0] < HOST_CPU_LOAD_INFO_COUNT) {
        log.debug({ result, count: countWord[0] }, "host_statistics(HOST_CPU_LOAD_INFO) failed");
        return null;
    }

    return { user: cpuWords[0], system: cpuWords[1], idle: cpuWords[2], nice: cpuWords[3] };
}

/**
 * The busy share of all cores between two tick readings, in percent with one decimal, as `100 - idle%` from `top`.
 * Null when no tick passed between them. The counters are 32-bit and wrap after weeks of uptime, so each difference
 * is taken modulo 2^32.
 */
export function cpuBusyPercent(previous: CpuTicks, current: CpuTicks): number | null {
    const user = (current.user - previous.user) >>> 0;
    const system = (current.system - previous.system) >>> 0;
    const idle = (current.idle - previous.idle) >>> 0;
    const nice = (current.nice - previous.nice) >>> 0;
    const total = user + system + idle + nice;

    if (total === 0) {
        return null;
    }

    return Math.round(((user + system + nice) / total) * 1000) / 10;
}

let lastSample: { ticks: CpuTicks; at: number } | null = null;

/**
 * The tick counters do not move on every tick: measured on 2026-10-12 (M-series, macOS 26.3) they changed every few
 * milliseconds for a while, then stood still for 966 to 990 ms. So a sample spans at least a second, and when the
 * counters still stood still after it, one more second.
 */
export const CPU_SAMPLE_MIN_MS = 1000;

/**
 * CPU busy percent since the previous call in this process, so a poller gets the average over its own interval.
 * The first call (and any call less than `minIntervalMs` after the previous one) waits until `minIntervalMs` has
 * passed since its starting read, then reads again; if no tick moved by then it waits `minIntervalMs` once more.
 * Null when the kernel read is unavailable or the counters still did not move.
 */
export async function sampleCpuBusyPercent(minIntervalMs = CPU_SAMPLE_MIN_MS): Promise<number | null> {
    let previous = lastSample;

    if (previous === null) {
        const ticks = readCpuTicks();

        if (!ticks) {
            return null;
        }

        previous = { ticks, at: performance.now() };
    }

    const elapsed = performance.now() - previous.at;

    if (elapsed < minIntervalMs) {
        await Bun.sleep(minIntervalMs - elapsed);
    }

    let current = readCpuTicks();

    if (current && cpuBusyPercent(previous.ticks, current) === null) {
        await Bun.sleep(minIntervalMs);
        current = readCpuTicks();
    }

    if (!current) {
        return null;
    }

    lastSample = { ticks: current, at: performance.now() };
    return cpuBusyPercent(previous.ticks, current);
}

/** `vm_stat`'s page counts (`host_statistics64(HOST_VM_INFO64)`), with the page size from `hw.pagesize`. */
export function readVmPageCounts(): VmPageCounts | null {
    const symbols = calls();

    if (!symbols || hostPort === null) {
        return null;
    }

    const pageSize = sysctlInteger("hw.pagesize");

    if (pageSize === null) {
        return null;
    }

    countWord[0] = HOST_VM_INFO64_COUNT;
    const result = symbols.host_statistics64(hostPort, HOST_VM_INFO64, vmWords, countWord);

    if (result !== KERN_SUCCESS || countWord[0] < VM_MIN_WORDS) {
        log.debug({ result, count: countWord[0] }, "host_statistics64(HOST_VM_INFO64) failed");
        return null;
    }

    return {
        pageSize,
        free: vmWords[VM_FREE] - vmWords[VM_SPECULATIVE],
        active: vmWords[VM_ACTIVE],
        inactive: vmWords[VM_INACTIVE],
        speculative: vmWords[VM_SPECULATIVE],
        throttled: countWord[0] > VM_THROTTLED ? vmWords[VM_THROTTLED] : 0,
        wired: vmWords[VM_WIRE],
        purgeable: vmWords[VM_PURGEABLE],
        compressed: vmWords[VM_COMPRESSOR],
    };
}

/** Physical memory in bytes (`hw.memsize`). */
export function readMemorySizeBytes(): number | null {
    return sysctlInteger("hw.memsize");
}

/**
 * The system-wide free memory percentage `memory_pressure` prints ("System-wide memory free percentage"), which is
 * `kern.memorystatus_level`.
 */
export function readMemoryFreePercent(): number | null {
    return sysctlInteger("kern.memorystatus_level");
}

/** `vm.swapusage` in exact bytes (the `sysctl` command prints it rounded to 0.01 MiB). */
export function readSwapUsage(): SwapUsage | null {
    if (sysctlWordsOf("vm.swapusage", XSW_USAGE_BYTES) !== XSW_USAGE_BYTES) {
        return null;
    }

    const total = sysctlWords[0] + sysctlWords[1] * 2 ** 32;
    const avail = sysctlWords[2] + sysctlWords[3] * 2 ** 32;
    const used = sysctlWords[4] + sysctlWords[5] * 2 ** 32;

    return { totalBytes: total, usedBytes: used, freeBytes: avail, encrypted: sysctlWords[7] !== 0 };
}
