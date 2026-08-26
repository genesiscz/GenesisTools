/**
 * Data collection for `status`: recorders (with live CPU/memory samples),
 * capture buffers, CDP endpoints, legacy leftovers, and recorder-shaped
 * processes that no pidfile owns. Read-only by definition.
 */
import { inspectPidFile, type PidFileState } from "@genesiscz/utils/process/pidfile";
import { captureDir, knownCapturePorts, listLegacyArmFiles, recorderPidPath } from "./paths.ts";
import {
    currentPlatform,
    defaultExec,
    type ExecFn,
    listProcesses,
    type Platform,
    type ProcessSample,
    sampleProcess,
} from "./platform.ts";
import { type RecorderMeta, readRecorderMeta } from "./recorder.ts";
import { listSegments } from "./segments.ts";

export { type ProcessSample, sampleProcess };

/** Every process that looks like a capture recorder — the new tool's or the old skill's. */
export function findRecorderProcesses(
    exec: ExecFn = defaultExec,
    platform: Platform = currentPlatform()
): { pid: number; command: string }[] {
    const found: { pid: number; command: string }[] = [];

    for (const proc of listProcesses(exec, platform)) {
        const command = proc.command;
        const isNew =
            /chrome-devtools[/\\](index\.ts|commands|lib)?.*\brecord\b/.test(command) ||
            /tools chrome-devtools record/.test(command);
        const isOld = /skills\/chrome-devtools\/scripts\/chrome-devtools\.ts\s+arm\b/.test(command);
        const isSelfLib = /src[/\\]chrome-devtools[/\\]index\.ts\s+record\b/.test(command);

        if (isNew || isOld || isSelfLib) {
            found.push({ pid: proc.pid, command });
        }
    }

    return found;
}

/**
 * Pids that are ancestors of any owned pid. A live recorder's launch chain
 * (`zsh -c 'tools chrome-devtools record …'` → `tools` wrapper → recorder)
 * carries the same argv, so command-shape matching alone flags the PARENTS of
 * a healthy recorder as killable orphans — a field test proved doctor would
 * have suggested killing the live 9224 recorder's own launcher.
 */
export function ancestorPids(
    ownedPids: Iterable<number>,
    exec: ExecFn = defaultExec,
    platform: Platform = currentPlatform()
): Set<number> {
    const parentOf = new Map<number, number>();
    for (const proc of listProcesses(exec, platform)) {
        if (proc.ppid !== null) {
            parentOf.set(proc.pid, proc.ppid);
        }
    }

    const ancestors = new Set<number>();
    for (const owned of ownedPids) {
        let current = parentOf.get(owned);
        let hops = 0;
        while (current !== undefined && current > 1 && hops < 50) {
            ancestors.add(current);
            current = parentOf.get(current);
            hops++;
        }
    }

    return ancestors;
}

export interface SegmentStats {
    count: number;
    bytes: number;
    oldestMs: number | null;
    newestMs: number | null;
}

export function segmentStats(port: number): SegmentStats {
    const segs = listSegments(captureDir(port));

    return {
        count: segs.length,
        bytes: segs.reduce((sum, s) => sum + s.bytes, 0),
        oldestMs: segs[0]?.startMs ?? null,
        newestMs: segs.at(-1)?.startMs ?? null,
    };
}

export interface EndpointProbe {
    browser: string;
    pages: number;
}

export async function probeEndpoint(port: number): Promise<EndpointProbe | null> {
    try {
        const [versionRes, listRes] = await Promise.all([
            fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) }),
            fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) }),
        ]);
        const v = (await versionRes.json()) as { Browser?: string };
        const list = (await listRes.json()) as { type: string }[];

        return { browser: v.Browser ?? "unknown", pages: list.filter((t) => t.type === "page").length };
    } catch {
        return null;
    }
}

export interface PortStatus {
    port: number;
    pidState: PidFileState;
    meta: RecorderMeta | null;
    sample: ProcessSample | null;
    segments: SegmentStats;
    endpoint: EndpointProbe | null;
}

export interface StatusReport {
    ports: PortStatus[];
    legacyFiles: string[];
    /** Recorder-shaped processes not owned by any live pidfile. */
    orphans: { pid: number; command: string; sample: ProcessSample | null }[];
}

export async function collectStatus(): Promise<StatusReport> {
    const ports = knownCapturePorts();
    const ownedPids = new Set<number>();

    // Probe all ports concurrently — dead ports cost a full timeout each, and
    // serial probing made status/doctor block for seconds per leftover dir.
    const portStatuses: PortStatus[] = await Promise.all(
        ports.map(async (port) => {
            const pidState = inspectPidFile(recorderPidPath(port));
            const livePid = pidState.status === "live" ? pidState.pid : null;
            if (livePid) {
                ownedPids.add(livePid);
            }

            return {
                port,
                pidState,
                meta: readRecorderMeta(port),
                sample: livePid ? sampleProcess(livePid) : null,
                segments: segmentStats(port),
                endpoint: await probeEndpoint(port),
            };
        })
    );

    const launcherPids = ancestorPids(ownedPids);
    const orphans = findRecorderProcesses()
        .filter((p) => !ownedPids.has(p.pid) && !launcherPids.has(p.pid) && p.pid !== process.pid)
        .map((p) => ({ ...p, sample: sampleProcess(p.pid) }));

    return { ports: portStatuses, legacyFiles: listLegacyArmFiles(), orphans };
}
