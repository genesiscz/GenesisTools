import { existsSync, readFileSync } from "node:fs";
import type { CmuxHealthState } from "@genesiscz/utils/cmux/lib/health";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/**
 * The memory of a cmux that does not answer, shared by every `cmux tree` process.
 *
 * A dead socket costs each tree call about 5 s (the first state command waits 3.5 s, then `ping` names the fault in
 * 1.5 s), and a poller that asks every 20 to 40 s kept that up for 2 h on 2026-11-02 (122 failures). After such a
 * failure the next calls answer at once with the remembered error, for a delay that doubles with each failure in a
 * row (20 s, 40 s, 80 s ... 5 min). A success clears it. A cmux with another pid (restarted) is asked at once.
 */
export interface CmuxTreeBackoff {
    /** Failures in a row; the delay doubles with each. */
    failures: number;
    /** Epoch ms before which a tree call answers from this record. */
    until: number;
    state: CmuxHealthState;
    /** The cmux app pid the probe saw. A different pid now means cmux restarted, and the memory does not apply. */
    appPid?: number;
    error: string;
}

export interface TreeBackoffStore {
    read(): CmuxTreeBackoff | null;
    write(record: CmuxTreeBackoff | null): void;
}

export const TREE_BACKOFF_FIRST_MS = 20_000;
export const TREE_BACKOFF_MAX_MS = 5 * 60_000;

/** Only cmux not answering earns a backoff: "not running" and "access denied" already fail at once. */
const BACKOFF_STATES: ReadonlySet<CmuxHealthState> = new Set(["socket-dead", "ui-starved"]);

const { log } = logger.scoped("cmux-tree-backoff");

export function treeBackoffDelayMs(failures: number): number {
    return Math.min(TREE_BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1), TREE_BACKOFF_MAX_MS);
}

/** The record to answer from now, or null when the tree should ask cmux. */
export function activeTreeBackoff({
    record,
    now,
    appPid,
}: {
    record: CmuxTreeBackoff | null;
    now: number;
    appPid: () => number | undefined;
}): CmuxTreeBackoff | null {
    if (!record || record.failures <= 0 || now >= record.until) {
        return null;
    }

    if (record.appPid !== undefined && appPid() !== record.appPid) {
        return null;
    }

    return record;
}

/** The record after a tree call: null after a success, a longer delay after another unresponsive failure. */
export function nextTreeBackoff({
    previous,
    unresponsive,
    error,
    now,
}: {
    previous: CmuxTreeBackoff | null;
    unresponsive: { state: CmuxHealthState; appPid?: number } | undefined;
    error: string | undefined;
    now: number;
}): CmuxTreeBackoff | null {
    if (!unresponsive || !BACKOFF_STATES.has(unresponsive.state)) {
        return null;
    }

    const failures = (previous?.appPid === unresponsive.appPid ? (previous?.failures ?? 0) : 0) + 1;

    return {
        failures,
        until: now + treeBackoffDelayMs(failures),
        state: unresponsive.state,
        ...(unresponsive.appPid !== undefined ? { appPid: unresponsive.appPid } : {}),
        error: error ?? `cmux ${unresponsive.state}`,
    };
}

/** The error a skipped call reports: the remembered one, and when cmux is asked again. */
export function skippedTreeError(record: CmuxTreeBackoff): string {
    const at = new Date(record.until).toTimeString().slice(0, 8);
    const times = record.failures === 1 ? "once" : `${record.failures} times in a row`;
    return `${record.error} (cmux was not asked again: it failed ${times}; the next try is after ${at})`;
}

export function fileTreeBackoffStore(path: string = genesisToolsDir("cmux", "tree-backoff.json")): TreeBackoffStore {
    return {
        read() {
            if (!existsSync(path)) {
                return null;
            }

            try {
                const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
                return isBackoff(parsed) ? parsed : null;
            } catch (error) {
                log.debug({ error, path }, "cmux tree backoff unreadable; asking cmux");
                return null;
            }
        },
        write(record) {
            try {
                atomicWriteFileSync(path, SafeJSON.stringify(record ?? { failures: 0, until: 0 }));
            } catch (error) {
                log.debug({ error, path }, "cmux tree backoff not written");
            }
        },
    };
}

function isBackoff(value: unknown): value is CmuxTreeBackoff {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    return (
        "failures" in value &&
        typeof value.failures === "number" &&
        "until" in value &&
        typeof value.until === "number" &&
        "state" in value &&
        typeof value.state === "string" &&
        "error" in value &&
        typeof value.error === "string" &&
        (!("appPid" in value) || typeof value.appPid === "number")
    );
}
