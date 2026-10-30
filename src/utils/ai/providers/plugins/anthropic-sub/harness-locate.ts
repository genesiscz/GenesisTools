import { join } from "node:path";
import type { FolderReads, LocateRoots, RankedHit } from "@genesiscz/utils/ai/transcripts/resolve";
import { findTurnFileWorker, idMatches, workerTurnChain } from "@genesiscz/utils/ai/transcripts/resolve-core";
import type { TranscriptLocator } from "@genesiscz/utils/harness/parts";

/** The roots a Claude lookup reads: an injected projects folder is the whole answer, else every root `nativeSessionRoots` knows. */
function claudeRoots({ injected, resolved }: LocateRoots): string[] {
    return injected.claudeProjects ? [injected.claudeProjects] : resolved.claudeProjectsAll;
}

/** The Claude driver's `locate` part: `<project>/<id>.jsonl` with its sub-agent files, and `tools claude worker` turn files. */
export const claudeLocate: TranscriptLocator = {
    pathRoots: (roots) => [
        ...claudeRoots(roots).map((root) => ({ root, source: "native" as const })),
        { root: roots.resolved.claudeWorker, source: "worker" },
    ],
    // A worker writes one turn file per turn, so its chain is followed (`rescanWorkerTurns`).
    sessionOfPath: ({ source, stem, filePath }) =>
        source === "worker"
            ? workerTurnChain({ provider: "claude", stem, filePath })
            : { provider: "claude", source, sessionId: stem.replace(/^agent-/, ""), filePath },
    find: (query, roots, fs) => [
        ...claudeRoots(roots).flatMap((root) => findClaude(query, root, fs)),
        ...findClaudeWorker(query, roots.resolved.claudeWorker, fs),
    ],
    // A `tools claude worker` writes only its own turn files.
    workerNative: () => null,
};

export function findClaude(query: string, projectsDir: string, fs: FolderReads): RankedHit[] {
    const hits: RankedHit[] = [];
    for (const project of fs.listDir(projectsDir)) {
        const projectDir = join(projectsDir, project);
        if (!fs.isDir(projectDir)) {
            continue;
        }
        const dirs = [projectDir, join(projectDir, "subagents")];
        for (const dir of dirs) {
            for (const entry of fs.listDir(dir)) {
                if (!entry.endsWith(".jsonl")) {
                    continue;
                }
                const id = entry.slice(0, -".jsonl".length);
                if (!idMatches(query, id)) {
                    continue;
                }
                const filePath = join(dir, entry);
                hits.push({
                    provider: "claude",
                    source: "native",
                    sessionId: id,
                    filePath,
                    mtime: fs.mtimeOf(filePath),
                });
            }
        }
    }
    return [...hits, ...findClaudeSubagent(query, projectsDir, fs)];
}

/** `aE-sharedkit-47434100f6deeb1c`, `a0564229bc9945515`, or either with its `agent-` file prefix. */
const SUBAGENT_ID = /^a[A-Za-z0-9][A-Za-z0-9_-]*$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A sub-agent transcript by its exact id: `<project>/<session>/subagents/agent-<id>.jsonl`.
 * Exact only, since every session directory is probed with one `existsSync`.
 */
function findClaudeSubagent(query: string, projectsDir: string, fs: FolderReads): RankedHit[] {
    const agentId = query.replace(/^agent-/, "");
    if (!SUBAGENT_ID.test(agentId) || UUID.test(agentId)) {
        return [];
    }

    const hits: RankedHit[] = [];
    for (const project of fs.listDir(projectsDir)) {
        const projectDir = join(projectsDir, project);
        for (const session of fs.listDir(projectDir)) {
            if (session.endsWith(".jsonl")) {
                continue;
            }

            const filePath = join(projectDir, session, "subagents", `agent-${agentId}.jsonl`);
            if (fs.exists(filePath)) {
                hits.push({
                    provider: "claude",
                    source: "native",
                    sessionId: agentId,
                    filePath,
                    mtime: fs.mtimeOf(filePath),
                });
            }
        }
    }

    return hits;
}

export function findClaudeWorker(query: string, workerDir: string, fs: FolderReads): RankedHit[] {
    return findTurnFileWorker(query, workerDir, "claude", fs);
}
