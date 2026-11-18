import { listProcessesWithUsage } from "@genesiscz/utils/process/processes";

/**
 * Which processes are spinning: two readings of accumulated CPU time a window apart. The doctor's `cpu-spin` analyzer
 * and the stuck-service rules of the root area read it.
 */

const GENESIS_FACE = /GenesisTools\.app\/Contents\/MacOS\/GenesisTools(?:\s+--(?:rpc|window)\b|\s*$)/;
const GENESIS_TOOL = /[/\\]GenesisTools[/\\](?:src|scripts)[/\\]|[/\\]\.genesis-tools[/\\]bin[/\\]gt-/;

export const DEFAULT_CPU_SPIN_WINDOW_MS = 1_500;
export const DEFAULT_CPU_SPIN_THRESHOLD_PERCENT = 25;

export interface CpuTimeSample {
    pid: number;
    cpuMs: number;
    command: string;
}

export interface SpinningProcess extends CpuTimeSample {
    /** CPU time burned between the two samples, as a share of one core over the window. */
    percent: number;
    deltaMs: number;
}

export type ProcessOwner = "genesis-face" | "genesis-tool" | null;

/**
 * Processes that burned at least `thresholdPercent` of one core between two samples. Two readings
 * of accumulated CPU time are exact where `ps -o pcpu` is a decaying average: pcpu smears a spin
 * that started a minute ago and hides one that started a second ago. A process born inside the
 * window has no first sample and is not judged.
 */
export function spinningProcesses(
    before: Map<number, CpuTimeSample>,
    after: Map<number, CpuTimeSample>,
    windowMs: number,
    thresholdPercent: number
): SpinningProcess[] {
    const found: SpinningProcess[] = [];

    for (const [pid, now] of after) {
        const earlier = before.get(pid);

        if (!earlier || earlier.command !== now.command) {
            continue;
        }

        const deltaMs = now.cpuMs - earlier.cpuMs;
        const percent = (deltaMs / windowMs) * 100;

        if (percent >= thresholdPercent) {
            found.push({ ...now, deltaMs, percent });
        }
    }

    return found.sort((a, b) => b.percent - a.percent);
}

/**
 * The two shapes this repo owns. A "face" is an argument-less or `--rpc`/`--window` instance of
 * GenesisTools.app, the class that spun at 60% for an hour on 2026-09-16 (`RunLoop.run` with no
 * sources returns at once); a "tool" is any bun process running this repo's code.
 */
export function processOwner(command: string): ProcessOwner {
    if (GENESIS_FACE.test(command)) {
        return "genesis-face";
    }

    if (GENESIS_TOOL.test(command)) {
        return "genesis-tool";
    }

    return null;
}

export function sampleCpuTimes(): Map<number, CpuTimeSample> | null {
    const entries = listProcessesWithUsage({ otherUsers: true });

    if (entries.length === 0) {
        return null;
    }

    return new Map(
        entries.flatMap((entry) =>
            entry.usage
                ? [
                      [
                          entry.pid,
                          { pid: entry.pid, cpuMs: entry.usage.cpuTimeMs, command: entry.command ?? entry.name },
                      ] as const,
                  ]
                : []
        )
    );
}
