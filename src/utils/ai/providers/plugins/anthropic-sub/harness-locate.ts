import { join } from "node:path";
import type { FolderReads, LocateRoots, RankedHit } from "@genesiscz/utils/ai/transcripts/resolve";
import {
    findTurnFileWorker,
    idMatches,
    listDir,
    mtimeOf,
    workerTurnChain,
} from "@genesiscz/utils/ai/transcripts/resolve-core";
import type { FindByTitleOptions, TitledSession } from "@genesiscz/utils/ai/transcripts/session-title";
import type { TranscriptLocator } from "@genesiscz/utils/harness/parts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { scanFileMatches } from "../../../transcripts/file-scan";

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
    rootsOfHome: (home) => ({ claudeProjects: join(home, "projects"), claudeProjectsAll: [join(home, "projects")] }),
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

const CUSTOM_TITLE = /"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g;

/** The last `/rename` title in a Claude transcript's text, or null. */
export function lastClaudeTitle(text: string): string | null {
    let last: string | null = null;

    for (const match of text.matchAll(CUSTOM_TITLE)) {
        last = match[1];
    }

    if (last === null) {
        return null;
    }

    try {
        const decoded = SafeJSON.parse(`"${last}"`, { strict: true });

        return typeof decoded === "string" ? decoded : last;
    } catch (err) {
        logger.debug({ err }, "[session-title] title escape unreadable; using it raw");
        return last;
    }
}

/** Bytes kept after each `custom-title` match: a title longer than this is not read. */
const TITLE_WINDOW = 4096;

/** The last `/rename` title of a transcript, streamed: a 200 MB transcript is never one string. */
function lastClaudeTitleIn(path: string): string | null {
    const found: { last: Buffer | null } = { last: null };
    scanFileMatches(path, '"type":"custom-title","customTitle":"', TITLE_WINDOW, (slice) => {
        found.last = Buffer.from(slice);
    });

    return found.last === null ? null : lastClaudeTitle(found.last.toString("utf8"));
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
