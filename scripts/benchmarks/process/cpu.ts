import { FFIType } from "bun:ffi";
import { readFileSync } from "node:fs";
import { defineSystemLibrary } from "@genesiscz/utils/bun/compiler";

/** `getrusage` is not in node:process for children; `<sys/resource.h>`: RUSAGE_CHILDREN -1, ru_utime 0, ru_stime 16. */
const rusage = defineSystemLibrary({
    path: "/usr/lib/libSystem.B.dylib",
    platforms: ["darwin"],
    symbols: { getrusage: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } },
});
const RUSAGE_CHILDREN = -1;
/** `struct rusage` is 144 bytes; each `timeval` is a 64-bit `tv_sec` (two words) and a 32-bit `tv_usec`. */
const rusageWords = new Uint32Array(144 / 4);
/** `/proc/self/stat` counts in clock ticks; Linux has used 100 per second on every mainstream build. */
const LINUX_TICKS_PER_SECOND = 100;

/**
 * CPU of every child this process has waited for: `getrusage(RUSAGE_CHILDREN)` on macOS, `cutime + cstime` from
 * `/proc/self/stat` on Linux, 0 elsewhere. An old call site spends nearly all of its time in `ps` or `lsof`, so a
 * figure without the children would call it free.
 */
export function childrenCpuMs(): number {
    if (process.platform === "linux") {
        const stat = readFileSync("/proc/self/stat", "utf8");
        // Fields after the `(comm)`, which may itself hold spaces: cutime is field 16 and cstime 17 (1-based).
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return ((Number(fields[13]) + Number(fields[14])) * 1000) / LINUX_TICKS_PER_SECOND;
    }

    const calls = rusage();

    if (calls?.getrusage(RUSAGE_CHILDREN, rusageWords) !== 0) {
        return 0;
    }

    const seconds = rusageWords[0] + rusageWords[1] * 2 ** 32 + rusageWords[4] + rusageWords[5] * 2 ** 32;
    const micros = rusageWords[2] + rusageWords[6];
    return seconds * 1000 + micros / 1000;
}

/** This process's CPU plus its waited-for children's, in ms. */
export function cpuNowMs(): number {
    const self = process.cpuUsage();
    return (self.user + self.system) / 1000 + childrenCpuMs();
}
