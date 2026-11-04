import type { PeerProcess } from "@genesiscz/utils/harness/parts";
import { readOpenFilePaths } from "@genesiscz/utils/process/socket-owner";

/** A plain or compressed rollout (Codex 0.164 compresses old ones to `.jsonl.zst`) under a `sessions/YYYY/MM/DD` folder. */
const ROLLOUT_FILE =
    /\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

/**
 * Codex writes each thread to `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl` and keeps that file
 * open while the thread runs (observed on codex-cli 0.159.2). One open rollout names the thread; several (an
 * app-server running many threads) name none, because the socket alone cannot say which thread made the call.
 */
export function codexThreadIdFromOpenFiles(paths: string[]): string | null {
    const ids = new Set<string>();

    for (const path of paths) {
        const match = path.match(ROLLOUT_FILE);

        if (match?.[1]) {
            ids.add(match[1].toLowerCase());
        }
    }

    return ids.size === 1 ? [...ids][0] : null;
}

/** The thread a running Codex process works in: the one rollout it holds open (`lsof`). */
export function codexPeerSession(process: PeerProcess): string | null {
    return codexThreadIdFromOpenFiles(readOpenFilePaths(process.pid));
}
