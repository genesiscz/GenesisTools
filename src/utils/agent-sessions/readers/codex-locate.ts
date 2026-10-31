import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { readCodexTitleIndex } from "@genesiscz/utils/agent-sessions/readers/codex-title";
import {
    directReads,
    type FolderReads,
    memoReads,
    type RankedHit,
    type ResolvedTranscript,
} from "@genesiscz/utils/ai/transcripts/resolve";
import { idMatches, isDir, isRecord, mtimeOf } from "@genesiscz/utils/ai/transcripts/resolve-core";
import type { TitledSession } from "@genesiscz/utils/ai/transcripts/session-title";
import { sessionsDir } from "@genesiscz/utils/codex/worker-paths";
import type { TranscriptLocator } from "@genesiscz/utils/harness/parts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    codexHomesWithLegacy,
    isNativeTranscript,
    nativeSessionRootsForHome,
    nativeTranscriptMaxDepth,
    transcriptStem,
} from "@genesiscz/utils/providers/session-paths";
import { isMissingFileError } from "@genesiscz/utils/storage/atomic-file";
import type { SessionPathRole } from "../types";

/**
 * A Codex `locate` part whose default homes are the ones under `home`. The driver's part reads the user's home; a test
 * passes a fixture home, so it never lists the real one.
 */
export function createCodexLocate(home = homedir()): TranscriptLocator {
    return {
        // Every home history lists (`codexHomesWithLegacy`), so a session the history shows is one a lookup finds.
        defaultRoots: () => ({ native: codexHomesWithLegacy(home), worker: sessionsDir() }),
        pathRoots: (roots) => [
            { root: roots.worker, source: "worker" },
            ...roots.native.map((root) => ({ root, source: "native" as const })),
        ],
        // A worker's file is its own session; a native rollout names its thread in the file name.
        sessionOfPath: ({ source, stem, filePath }) => ({
            provider: "codex",
            source,
            sessionId: source === "native" ? codexNativeSessionId(filePath) : stem,
            filePath,
        }),
        find: (query, roots, fs) => [
            ...findCodexNative(query, roots.native, fs),
            ...findCodexWorker(query, roots.worker, fs),
        ],
        rootsOfHome: (codexHome) => ({ native: [codexHome] }),
        // Codex keeps its titles in `session_index.jsonl` of each home.
        titledSessions: ({ options }) =>
            codexSessions(options.codexIndexPath ? [options.codexIndexPath] : codexIndexPaths(home)),
        // A `tools codex spawn` worker runs a real native thread; its rollout sits in the worker's own Codex home.
        workerNative: (worker, fs) => {
            const workerHome = workerHomeOf(worker, fs);
            const homes = workerHome ? [workerHome] : codexHomesWithLegacy(home);
            const best = findCodexNative(worker.sessionId, homes, fs).sort((a, b) => b.mtime - a.mtime)[0];
            return best
                ? { provider: best.provider, source: best.source, sessionId: best.sessionId, filePath: best.filePath }
                : null;
        },
    };
}

/** The Codex driver's `locate` part: rollouts under each Codex home, and `tools codex spawn` worker logs. */
export const codexLocate: TranscriptLocator = createCodexLocate();

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

export function codexNativeSessionId(entry: string): string {
    const stem = transcriptStem(basename(entry)).replace(/^rollout-/, "");
    const uuid = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    return uuid?.[0] ?? stem;
}

/**
 * Every rollout under one Codex home, the one walk the locator and the rollout finder share: each session root of the
 * home (`nativeSessionRootsForHome`, the roots history discovery walks too), folders down to
 * `nativeTranscriptMaxDepth("codex")` (`YYYY/MM/DD`, and `archived_sessions` keeps files flat), and the files
 * `isCodexRolloutPath` accepts (discovery's own filter). Newest name first at every level, so a caller looking for one
 * thread can stop at the first hit. A rollout name is matched before the folder test, so a file costs no `stat`.
 */
export function* codexRollouts(home: string, fs: FolderReads): Generator<{ dir: string; entry: string }> {
    const maxDepth = nativeTranscriptMaxDepth("codex");

    function* walk(dir: string, depth: number): Generator<{ dir: string; entry: string }> {
        for (const entry of [...fs.listDir(dir)].sort().reverse()) {
            if (isCodexRolloutPath(entry)) {
                yield { dir, entry };
            } else if (depth < maxDepth && fs.isDir(join(dir, entry))) {
                yield* walk(join(dir, entry), depth + 1);
            }
        }
    }

    for (const root of nativeSessionRootsForHome("codex", home)) {
        yield* walk(root, 1);
    }
}

export function findCodexNative(query: string, homes: readonly string[], fs: FolderReads): RankedHit[] {
    const hits: RankedHit[] = [];
    for (const home of homes) {
        for (const { dir, entry } of codexRollouts(home, fs)) {
            if (!idMatches(query, entry)) {
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

/** The index of each Codex home transcript resolution reads (`codexHomesWithLegacy`). */
export function codexIndexPaths(home = homedir()): string[] {
    return codexHomesWithLegacy(home).map((home) => join(home, "session_index.jsonl"));
}

/**
 * The titled threads of the given session indexes. Codex appends a line per rename, in write order, so the last line
 * of an id in one index is its current title there. A thread in two homes (a legacy profile home copied from the
 * default one) takes its title from the home of its newest rollout, the one a lookup of its id resolves to, and points
 * at that rollout, so the title and the transcript come from one pick.
 */
export function codexSessions(indexPaths: readonly string[], fs: FolderReads = directReads): TitledSession[] {
    const byThread = new Map<string, Map<string, TitledSession>>();

    for (const indexPath of indexPaths) {
        if (!existsSync(indexPath)) {
            continue;
        }

        const found = new Map<string, TitledSession>();
        readCodexTitleIndex(indexPath, found);

        for (const [id, session] of found) {
            const homes = byThread.get(id) ?? new Map<string, TitledSession>();
            homes.set(dirname(indexPath), session);
            byThread.set(id, homes);
        }
    }

    // Every thread in two homes walks the same rollout folders, so the pass lists each folder once.
    const reads = memoReads(fs);

    return [...byThread.values()].flatMap((homes) => {
        const [first] = homes.values();
        return first ? [homes.size === 1 ? first : titleOfNewestRollout(homes, first, reads)] : [];
    });
}

/** The title of a thread several homes index, from the home that holds its newest rollout, pointing at that rollout. */
function titleOfNewestRollout(
    homes: ReadonlyMap<string, TitledSession>,
    first: TitledSession,
    fs: FolderReads
): TitledSession {
    const newest = findCodexNative(first.sessionId, [...homes.keys()], fs).sort((a, b) => b.mtime - a.mtime)[0];
    const home = newest ? [...homes.keys()].find((path) => newest.filePath.startsWith(`${path}${sep}`)) : undefined;
    const session = home ? homes.get(home) : undefined;

    // No rollout in any of them: the default home's title, which a lookup cannot resolve either.
    return newest && session ? { ...session, locator: newest.filePath } : first;
}

/** A Codex rollout, plain or compressed (`rollout-….jsonl` or `.jsonl.zst`): the only file Codex discovery reads. */
export function isCodexRolloutPath(path: string): boolean {
    const name = path.split(/[/\\]/).at(-1) ?? "";
    return name.startsWith("rollout-") && isNativeTranscript("codex", name);
}

/** `NativeSessionReader.classifyPath` for Codex: a rollout, plain or compressed, under a session root. */
export function codexClassifyPath(relativePath: string): SessionPathRole | null {
    const name = relativePath.split(/[/\\]/).at(-1) ?? "";

    return isCodexRolloutPath(name)
        ? {
              owner: "session",
              file: "transcript",
              sessionId: codexNativeSessionId(name),
              parentSessionId: null,
              nested: false,
          }
        : null;
}

/**
 * A folder's entries for `findCodexRollout`. A folder that is there but cannot be read hides its rollouts, so it is
 * logged; a missing one (a home with no `archived_sessions`) is the normal case and stays silent.
 */
function listRolloutDir(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch (error) {
        if (!isMissingFileError(error)) {
            logger.debug({ error, dir }, "[transcripts] codex sessions directory not readable");
        }

        return [];
    }
}

/** Direct folder reads for `findCodexRollout`, which reads outside a lookup batch. */
const ROLLOUT_READS: FolderReads = {
    listDir: listRolloutDir,
    isDir,
    mtimeOf,
    exists: existsSync,
    readText: (path) => readFileSync(path, "utf8"),
};

/**
 * The rollout of a Codex thread: `<home>/sessions/YYYY/MM/DD/rollout-<ts>-<thread id>.jsonl` (or `.jsonl.zst` once
 * Codex compressed it), or the same in `archived_sessions`, which also keeps files directly in its root. Newest days
 * are searched first (`codexRollouts`), and the first hit answers.
 */
export function findCodexRollout(threadId: string, homes: readonly string[] = codexHomesWithLegacy()): string | null {
    if (!/^[A-Za-z0-9-]+$/.test(threadId)) {
        return null;
    }

    const isThread = (entry: string) =>
        entry.endsWith(`-${threadId}.jsonl`) || entry.endsWith(`-${threadId}.jsonl.zst`);

    for (const home of homes) {
        for (const { dir, entry } of codexRollouts(home, ROLLOUT_READS)) {
            if (isThread(entry)) {
                return join(dir, entry);
            }
        }
    }

    return null;
}
