import { env } from "@genesiscz/utils/env";
import { freeDiskSpace } from "@genesiscz/utils/fs/disk-usage";
import { listProcesses, readProcessUsages } from "@genesiscz/utils/process/processes";

/** Free space under this: no walk (a walk can fail halfway on a full volume). The Disk Manager's critical tier. */
export const SCAN_GATE_FLOOR_BYTES = 1024 * 1024 * 1024;
/** `fseventsd` resident memory at or over this: no walk (a walk is one more event flood). Healthy is a few MB. */
export const SCAN_GATE_FSEVENTSD_LIMIT_BYTES = 1024 * 1024 * 1024;
const MEMO_MS = 10_000;

export interface ScanGateState {
    /** True: list names and ages only (readdir + lstat), skip every size walk and deep search. */
    gated: boolean;
    reasons: string[];
    availableBytes: number | null;
    floorBytes: number;
    fseventsdRssBytes: number | null;
    fseventsdLimitBytes: number;
}

export type ScanGateReader = () => Promise<ScanGateState>;

let memo: { at: number; state: Promise<ScanGateState> } | null = null;
let lastState: ScanGateState | null = null;

/** The largest resident size among rows named `name`. Null when none of them reported one. */
export function hottestRss(rows: Array<{ name: string; rssBytes: number | null }>, name: string): number | null {
    let hottest: number | null = null;

    for (const row of rows) {
        if (row.name !== name || row.rssBytes === null) {
            continue;
        }

        if (hottest === null || row.rssBytes > hottest) {
            hottest = row.rssBytes;
        }
    }

    return hottest;
}

export function evaluateScanGate(input: {
    availableBytes: number | null;
    fseventsdRssBytes: number | null;
}): ScanGateState {
    const reasons: string[] = [];

    if (input.availableBytes !== null && input.availableBytes < SCAN_GATE_FLOOR_BYTES) {
        reasons.push("free space is under the critical floor");
    }

    if (input.fseventsdRssBytes !== null && input.fseventsdRssBytes >= SCAN_GATE_FSEVENTSD_LIMIT_BYTES) {
        reasons.push("fseventsd is hot");
    }

    return {
        gated: reasons.length > 0,
        reasons,
        availableBytes: input.availableBytes,
        floorBytes: SCAN_GATE_FLOOR_BYTES,
        fseventsdRssBytes: input.fseventsdRssBytes,
        fseventsdLimitBytes: SCAN_GATE_FSEVENTSD_LIMIT_BYTES,
    };
}

async function probe(): Promise<ScanGateState> {
    let availableBytes: number | null = null;

    try {
        availableBytes = freeDiskSpace(env.tools.getHome()).available;
    } catch {
        availableBytes = null;
    }

    const daemons = listProcesses({ commands: false }).filter((entry) => entry.name === "fseventsd");
    const usages = readProcessUsages(
        daemons.map((entry) => entry.pid),
        { otherUsers: true }
    );
    const fseventsdRssBytes = hottestRss(
        daemons.map((entry) => ({ name: entry.name, rssBytes: usages.get(entry.pid)?.rssBytes ?? null })),
        "fseventsd"
    );
    return evaluateScanGate({ availableBytes, fseventsdRssBytes });
}

/** The gate for this process, read at most once per 10 s (one `statfs` and one process-table read). */
export async function readScanGate(): Promise<ScanGateState> {
    const now = Date.now();

    if (!memo || now - memo.at > MEMO_MS) {
        memo = { at: now, state: probe() };
    }

    const state = await memo.state;
    lastState = state;
    return state;
}

/** What the last {@link readScanGate} of any analyzer in this process saw, for the `--json` document. */
export function lastScanGate(): ScanGateState | null {
    return lastState;
}

export function recordScanGate(state: ScanGateState): void {
    lastState = state;
}
