import { basename, join } from "node:path";
import type { FolderReads, RankedHit, ResolvedTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { idMatches, isRecord } from "@genesiscz/utils/ai/transcripts/resolve-core";
import { env } from "@genesiscz/utils/env";
import type { TranscriptLocator } from "@genesiscz/utils/harness/parts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { codexHomeOverrides, isNativeTranscript, transcriptStem } from "@genesiscz/utils/providers/session-paths";

/** The Codex driver's `locate` part: rollouts under each Codex home, and `tools codex spawn` worker logs. */
export const codexLocate: TranscriptLocator = {
    pathRoots: ({ resolved }) => [
        { root: resolved.codexWorker, source: "worker" },
        ...splitCodexHomes(resolved.codexHome).map((root) => ({ root, source: "native" as const })),
    ],
    // A worker's file is its own session; a native rollout names its thread in the file name.
    sessionOfPath: ({ source, stem, filePath }) => ({
        provider: "codex",
        source,
        sessionId: source === "native" ? codexNativeSessionId(filePath) : stem,
        filePath,
    }),
    find: (query, { resolved }, fs) => [
        ...findCodexNative(query, resolved.codexHome, fs),
        ...findCodexWorker(query, resolved.codexWorker, fs),
    ],
    // A `tools codex spawn` worker runs a real native thread; its rollout sits in the worker's own Codex home.
    workerNative: (worker, fs) => {
        const home = workerHomeOf(worker, fs);

        if (!home) {
            return null;
        }

        const best = findCodexNative(worker.sessionId, home, fs).sort((a, b) => b.mtime - a.mtime)[0];
        return best
            ? { provider: best.provider, source: best.source, sessionId: best.sessionId, filePath: best.filePath }
            : null;
    },
};

/** A worker's Codex home from its `.meta.json` beside the event log; undefined when it records none. */
function workerHomeOf(worker: ResolvedTranscript, fs: FolderReads): string | undefined {
    try {
        const meta: unknown = SafeJSON.parse(fs.readText(worker.filePath.replace(/\.jsonl$/, ".meta.json")));

        if (meta && typeof meta === "object" && "home" in meta && typeof meta.home === "string") {
            return meta.home;
        }
    } catch (err) {
        logger.debug({ err, path: worker.filePath }, "[transcripts] codex worker metadata unavailable");
    }

    return undefined;
}

/** The default root is the raw `CODEX_HOME` comma list, so it names every home; any other root is one home. */
export function splitCodexHomes(codexHome: string): string[] {
    if (codexHome === env.codex.getHomeOverride()) {
        return codexHomeOverrides();
    }

    return [codexHome];
}

export function codexNativeSessionId(entry: string): string {
    const stem = transcriptStem(basename(entry)).replace(/^rollout-/, "");
    const uuid = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    return uuid?.[0] ?? stem;
}

/** Files of one Codex bucket: the `YYYY/MM/DD` tree, and files directly in it (`archived_sessions` is flat). */
function* codexBucketEntries(root: string, fs: FolderReads): Generator<{ dir: string; entry: string }> {
    for (const year of fs.listDir(root)) {
        const yearDir = join(root, year);
        if (!fs.isDir(yearDir)) {
            yield { dir: root, entry: year };
            continue;
        }
        for (const month of fs.listDir(yearDir)) {
            const monthDir = join(yearDir, month);
            if (!fs.isDir(monthDir)) {
                continue;
            }
            for (const day of fs.listDir(monthDir)) {
                const dayDir = join(monthDir, day);
                if (!fs.isDir(dayDir)) {
                    continue;
                }
                for (const entry of fs.listDir(dayDir)) {
                    yield { dir: dayDir, entry };
                }
            }
        }
    }
}

export function findCodexNative(query: string, codexHome: string, fs: FolderReads): RankedHit[] {
    const hits: RankedHit[] = [];
    const homes = splitCodexHomes(codexHome);
    for (const home of homes) {
        for (const bucket of ["sessions", "archived_sessions"]) {
            for (const { dir, entry } of codexBucketEntries(join(home, bucket), fs)) {
                // Codex 0.164 compresses old rollouts to `.jsonl.zst`.
                if (!isNativeTranscript("codex", entry) || !idMatches(query, entry)) {
                    continue;
                }
                const filePath = join(dir, entry);
                hits.push({
                    provider: "codex",
                    source: "native",
                    sessionId: codexNativeSessionId(entry),
                    filePath,
                    mtime: fs.mtimeOf(filePath),
                });
            }
        }
    }
    return hits;
}

export function findCodexWorker(query: string, workerDir: string, fs: FolderReads): RankedHit[] {
    const hits: RankedHit[] = [];
    for (const entry of fs.listDir(workerDir)) {
        if (!entry.endsWith(".meta.json")) {
            continue;
        }
        const name = entry.slice(0, -".meta.json".length);
        let sessionId = name;
        try {
            const meta = SafeJSON.parse(fs.readText(join(workerDir, entry)));
            if (isRecord(meta)) {
                if (typeof meta.threadId === "string" && meta.threadId) {
                    sessionId = meta.threadId;
                } else if (typeof meta.name === "string" && meta.name) {
                    sessionId = meta.name;
                }
            }
        } catch {
            // Name-only match still works when meta is unreadable.
        }
        if (!idMatches(query, name) && !idMatches(query, sessionId)) {
            continue;
        }
        const filePath = join(workerDir, `${name}.jsonl`);
        if (!fs.exists(filePath)) {
            continue;
        }
        hits.push({
            provider: "codex",
            source: "worker",
            sessionId,
            filePath,
            mtime: fs.mtimeOf(filePath),
        });
    }
    return hits;
}
