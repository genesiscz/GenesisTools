import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { grokTitleOf } from "@genesiscz/utils/agent-sessions/readers/grok-title";
import type { FolderReads, RankedHit } from "@genesiscz/utils/ai/transcripts/resolve";
import { findTurnFileWorker, idMatches, isRecord, workerTurnChain } from "@genesiscz/utils/ai/transcripts/resolve-core";
import { listDir, mtimeOf, type TitledSession } from "@genesiscz/utils/ai/transcripts/session-title";
import { env } from "@genesiscz/utils/env";
import { sessionsDir } from "@genesiscz/utils/grok/worker-paths";
import type { TranscriptLocator } from "@genesiscz/utils/harness/parts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/** The Grok driver's `locate` part: `<cwd>/<sessionId>/updates.jsonl` under the Grok home, and worker turn files. */
export const grokLocate: TranscriptLocator = {
    // A worker home can be the native home of a worker process, so the worker root is matched first.
    defaultRoots: () => ({ native: [env.grok.getHome()], worker: sessionsDir() }),
    pathRoots: (roots) => [
        { root: roots.worker, source: "worker" },
        ...roots.native.map((root) => ({ root, source: "native" as const })),
    ],
    // Native grok is `<cwd>/<sessionId>/updates.jsonl`: the id is the folder.
    sessionOfPath: ({ source, stem, filePath }) =>
        source === "worker"
            ? workerTurnChain({ provider: "grok", stem, filePath })
            : { provider: "grok", source, sessionId: basename(dirname(filePath)), filePath },
    find: (query, roots, fs) => [
        ...roots.native.flatMap((home) => findGrokNative(query, home, fs)),
        ...findGrokWorker(query, roots.worker, fs),
    ],
    // A `tools grok` worker writes only its own turn files.
    workerNative: () => null,
    rootsOfHome: (home) => ({ native: [home] }),
    // Each session folder's summary names its title.
    titledSessions: ({ roots }) => grokSessions(roots),
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

export function grokSessions(roots: string[]): TitledSession[] {
    const found: TitledSession[] = [];

    for (const root of roots) {
        for (const cwdDir of listDir(root)) {
            for (const id of listDir(join(root, cwdDir))) {
                const dir = join(root, cwdDir, id);
                const summaryPath = join(dir, "summary.json");
                const updates = join(dir, "updates.jsonl");

                if (!existsSync(summaryPath) || !existsSync(updates)) {
                    continue;
                }

                try {
                    const summary: unknown = SafeJSON.parse(readFileSync(summaryPath, "utf8"), { strict: true });
                    const title = isRecord(summary) ? grokTitleOf(summary) : null;

                    if (title) {
                        found.push({ sessionId: id, title, mtime: mtimeOf(updates), locator: updates });
                    }
                } catch (err) {
                    logger.debug({ err, summaryPath }, "[session-title] could not read a Grok summary");
                }
            }
        }
    }

    return found;
}
