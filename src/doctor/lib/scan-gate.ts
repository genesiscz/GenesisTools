import { basename } from "node:path";
import { env } from "@genesiscz/utils/env";
import { freeDiskSpace } from "@genesiscz/utils/fs/disk-usage";
import { run } from "./run";

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

export function parseFseventsdRss(psOutput: string): number | null {
    for (const line of psOutput.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);

        if (match && basename(match[2]!.trim()) === "fseventsd") {
            return Number.parseInt(match[1]!, 10) * 1024;
        }
    }

    return null;
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

    const ps = await run("ps", ["-axo", "rss=,comm="], { timeoutMs: 5_000 });
    const fseventsdRssBytes = ps.status === 0 ? parseFseventsdRss(ps.stdout) : null;
    return evaluateScanGate({ availableBytes, fseventsdRssBytes });
}

/** The gate for this process, read at most once per 10 s (one `statfs` and one `ps`). */
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
