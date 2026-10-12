/**
 * The busy work in a `/usr/bin/sample` report: its "Sort by top of stack" section, without the frames where a thread
 * only waits. This is the view of every thread (thread pools, the JIT, the garbage collector) that the JavaScript
 * profile cannot give: on 2026-10-12 it showed file opens on Bun's pool threads as the top cost of a command whose
 * JavaScript profile pointed elsewhere.
 */
export interface ThreadHotspot {
    symbol: string;
    library: string;
    samples: number;
}

export interface ThreadSampleSummary {
    /** Samples where a thread was doing work, across all threads. */
    busySamples: number;
    waitingSamples: number;
    hotspots: ThreadHotspot[];
}

/** Top-of-stack symbols that mean "this thread is parked", not "this thread costs CPU". */
const WAITING = new Set([
    "__psynch_cvwait",
    "__psynch_mutexwait",
    "__ulock_wait",
    "__ulock_wait2",
    "__semwait_signal",
    "__workq_kernreturn",
    "kevent",
    "kevent64",
    "kevent_id",
    "mach_msg2_trap",
    "mach_msg_trap",
    "__select",
    "poll",
    "__sigsuspend",
    "__wait4",
    "syscall_thread_switch",
]);

const LINE = /^\s+(.+?)\s+\(in ([^)]+)\)(?:\s+.*?)?\s+(\d+)\s*$/;

export function parseThreadSample(report: string): ThreadSampleSummary {
    const start = report.indexOf("Sort by top of stack");
    const end = report.indexOf("Binary Images", start);
    const section = start < 0 ? "" : report.slice(start, end < 0 ? undefined : end);
    const hotspots: ThreadHotspot[] = [];
    let busySamples = 0;
    let waitingSamples = 0;

    for (const line of section.split("\n").slice(1)) {
        const match = LINE.exec(line);

        if (!match) {
            continue;
        }

        const symbol = match[1].trim();
        const samples = Number(match[3]);

        if (WAITING.has(symbol)) {
            waitingSamples += samples;
            continue;
        }

        busySamples += samples;
        // A stripped binary (Bun) reports each address as "???"; one row per library says the same thing once.
        const named = symbol === "???" ? "(no symbols)" : symbol;
        const existing = hotspots.find((spot) => spot.symbol === named && spot.library === match[2]);

        if (existing) {
            existing.samples += samples;
        } else {
            hotspots.push({ symbol: named, library: match[2], samples });
        }
    }

    hotspots.sort((left, right) => right.samples - left.samples);
    return { busySamples, waitingSamples, hotspots };
}
