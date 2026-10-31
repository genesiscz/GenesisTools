import { join } from "node:path";
import { lastClaudeTitleIn } from "@genesiscz/utils/agent-sessions/readers/claude-title";
import type { FolderReads, RankedHit } from "@genesiscz/utils/ai/transcripts/resolve";
import { findTurnFileWorker, idMatches, workerTurnChain } from "@genesiscz/utils/ai/transcripts/resolve-core";
import {
    type FindByTitleOptions,
    listDir,
    mtimeOf,
    type TitledSession,
} from "@genesiscz/utils/ai/transcripts/session-title";
import { workersDir } from "@genesiscz/utils/claude/worker-paths";
import type { TranscriptLocator } from "@genesiscz/utils/harness/parts";
import { logger } from "@genesiscz/utils/logger";
import { nativeSessionRoots, nativeSessionRootsForHome } from "@genesiscz/utils/providers/session-paths";
import { claudeSubagentFiles, claudeSubagentsDir } from "./claude-paths";

/** The Claude driver's `locate` part: `<project>/<id>.jsonl` with its sub-agent files, and `tools claude worker` turn files. */
export const claudeLocate: TranscriptLocator = {
    // `nativeSessionRoots` owns the root policy: a hard-coded `~/.claude/projects` missed `~/.config/claude/projects`
    // and `$CLAUDE_CONFIG_DIR` (PR #341 review round 4, t3).
    defaultRoots: () => ({ native: nativeSessionRoots("claude"), worker: workersDir() }),
    pathRoots: (roots) => [
        ...roots.native.map((root) => ({ root, source: "native" as const })),
        { root: roots.worker, source: "worker" },
    ],
    // A worker writes one turn file per turn, so its chain is followed (`rescanWorkerTurns`).
    sessionOfPath: ({ source, stem, filePath }) =>
        source === "worker"
            ? workerTurnChain({ provider: "claude", stem, filePath })
            : { provider: "claude", source, sessionId: stem.replace(/^agent-/, ""), filePath },
    find: (query, roots, fs) => [
        ...roots.native.flatMap((root) => findClaude(query, root, fs)),
        ...findClaudeWorker(query, roots.worker, fs),
    ],
    // A `tools claude worker` writes only its own turn files.
    workerNative: () => null,
    rootsOfHome: (home) => ({ native: nativeSessionRootsForHome("claude", home) }),
    // The `custom-title` rows of the transcripts written in the last `maxAgeDays`, within a time budget.
    titledSessions: ({ options, roots, now }) =>
        claudeSessions({ roots, maxAgeDays: options.maxAgeDays ?? 14, budgetMs: options.budgetMs ?? 8000, now }),
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

            const filePath = claudeSubagentFiles(
                claudeSubagentsDir(join(projectDir, `${session}.jsonl`)),
                agentId
            ).transcript;
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

export function claudeSessions({
    roots,
    maxAgeDays,
    budgetMs,
    now,
}: Required<Pick<FindByTitleOptions, "roots" | "maxAgeDays" | "budgetMs" | "now">>): TitledSession[] {
    const cutoff = now - maxAgeDays * 86_400_000;
    const files: { path: string; mtime: number }[] = [];

    for (const root of roots) {
        for (const project of listDir(root)) {
            for (const entry of listDir(join(root, project))) {
                if (!entry.endsWith(".jsonl")) {
                    continue;
                }

                const path = join(root, project, entry);
                const mtime = mtimeOf(path);

                if (mtime >= cutoff) {
                    files.push({ path, mtime });
                }
            }
        }
    }

    files.sort((a, b) => b.mtime - a.mtime);
    const found: TitledSession[] = [];
    const deadline = Date.now() + budgetMs;

    for (const file of files) {
        if (Date.now() > deadline) {
            logger.warn(
                { read: found.length, total: files.length },
                "[session-title] time budget spent; the title scan is partial"
            );
            break;
        }

        try {
            const title = lastClaudeTitleIn(file.path);

            if (title) {
                found.push({
                    sessionId:
                        file.path
                            .split("/")
                            .at(-1)
                            ?.replace(/\.jsonl$/, "") ?? file.path,
                    title,
                    mtime: file.mtime,
                    locator: file.path,
                });
            }
        } catch (err) {
            logger.debug({ err, path: file.path }, "[session-title] could not read a transcript");
        }
    }

    return found;
}
