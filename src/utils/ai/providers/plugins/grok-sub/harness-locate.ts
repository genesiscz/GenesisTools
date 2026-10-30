import { basename, dirname, join } from "node:path";
import type { FolderReads, RankedHit } from "@genesiscz/utils/ai/transcripts/resolve";
import { findTurnFileWorker, idMatches, workerTurnChain } from "@genesiscz/utils/ai/transcripts/resolve-core";
import type { TranscriptLocator } from "@genesiscz/utils/harness/parts";

/** The Grok driver's `locate` part: `<cwd>/<sessionId>/updates.jsonl` under the Grok home, and worker turn files. */
export const grokLocate: TranscriptLocator = {
    // A worker home can be the native home of a worker process, so the worker root is matched first.
    pathRoots: ({ resolved }) => [
        { root: resolved.grokWorker, source: "worker" },
        { root: resolved.grokHome, source: "native" },
    ],
    // Native grok is `<cwd>/<sessionId>/updates.jsonl`: the id is the folder.
    sessionOfPath: ({ source, stem, filePath }) =>
        source === "worker"
            ? workerTurnChain({ provider: "grok", stem, filePath })
            : { provider: "grok", source, sessionId: basename(dirname(filePath)), filePath },
    find: (query, { resolved }, fs) => [
        ...findGrokNative(query, resolved.grokHome, fs),
        ...findGrokWorker(query, resolved.grokWorker, fs),
    ],
};

export function findGrokNative(query: string, grokHome: string, fs: FolderReads): RankedHit[] {
    const hits: RankedHit[] = [];
    const root = join(grokHome, "sessions");
    for (const cwdEnc of fs.listDir(root)) {
        const cwdDir = join(root, cwdEnc);
        if (!fs.isDir(cwdDir)) {
            continue;
        }
        for (const id of fs.listDir(cwdDir)) {
            if (!idMatches(query, id)) {
                continue;
            }
            const filePath = join(cwdDir, id, "updates.jsonl");
            if (!fs.exists(filePath)) {
                continue;
            }
            hits.push({
                provider: "grok",
                source: "native",
                sessionId: id,
                filePath,
                mtime: fs.mtimeOf(filePath),
            });
        }
    }
    return hits;
}

export function findGrokWorker(query: string, workerDir: string, fs: FolderReads): RankedHit[] {
    return findTurnFileWorker(query, workerDir, "grok", fs);
}
