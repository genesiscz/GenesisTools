import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { lastClaudeTitleIn } from "@genesiscz/utils/agent-sessions/readers/claude-title";
import type { FolderReads, HarnessRoots, RankedHit } from "@genesiscz/utils/ai/transcripts/resolve";
import {
    findTurnFileWorker,
    idMatches,
    isDir,
    listDir,
    mtimeOf,
    workerTurnChain,
} from "@genesiscz/utils/ai/transcripts/resolve-core";
import type { FindByTitleOptions, TitledSession } from "@genesiscz/utils/ai/transcripts/session-title";
import { workersDir } from "@genesiscz/utils/claude/worker-paths";
import type { CallerTranscriptQuery, TranscriptLocator } from "@genesiscz/utils/harness/parts";
import { logger } from "@genesiscz/utils/logger";
import {
    defaultNativeHome,
    nativeHomeOverrideVariable,
    nativeSessionRoots,
    nativeSessionRootsForHome,
} from "@genesiscz/utils/providers/session-paths";
import { canonicalClaudeCopy, canonicalClaudeCopySync } from "./claude-discovery";
import { claudeSubagentCandidates, isClaudeSubagentPath } from "./claude-paths";

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
    callerTranscript: claudeCallerTranscript,
};

/** Claude names a project folder after the session's cwd with every non-alphanumeric character as `-`. */
export function claudeProjectFolder(cwd: string): string {
    return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * `TranscriptLocator.callerTranscript` for Claude: `<config dir>/projects/<cwd as folder>/<session>.jsonl`, tried for
 * each cwd, then one listing of the project folders. The config dir is the caller's `CLAUDE_CONFIG_DIR`, else the
 * default under `home`. One path join per cwd on a hit, so a failed run pays no walk over every session folder.
 */
function claudeCallerTranscript({ sessionId, env, cwds, home }: CallerTranscriptQuery): string | null {
    const configDir = env[nativeHomeOverrideVariable("claude")]?.trim() || defaultNativeHome("claude", home);
    const projects = join(configDir, "projects");
    const file = `${sessionId}.jsonl`;

    for (const cwd of cwds) {
        const direct = join(projects, claudeProjectFolder(cwd), file);
        if (existsSync(direct)) {
            return direct;
        }
    }

    if (!existsSync(projects)) {
        return null;
    }

    for (const folder of readdirSync(projects)) {
        const candidate = join(projects, folder, file);
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

const folderReads: FolderReads = {
    listDir,
    isDir,
    mtimeOf,
    exists: existsSync,
    readText: (path) => readFileSync(path, "utf8"),
};

/** Where a Claude id lookup looks beyond the main transcripts of every project folder. */
export interface ClaudeTranscriptScope {
    /** Only this project folder (its encoded name, `claudeProjectFolder`) under each root. */
    projectFolder?: string;
    /** Also answer a sub-agent transcript (`subagents/`), as `ClaudeSession.fromSessionId` does. */
    includeSubagents?: boolean;
}

/**
 * An id prefix that starts two or more Claude session ids. Both locator forms throw it rather than pick one; `ids`
 * are the full ids it matched, so a CLI can print them or ask which one, and an exact id never throws it.
 */
export class AmbiguousSessionIdError extends Error {
    constructor(
        readonly prefix: string,
        readonly ids: readonly string[]
    ) {
        super(
            `The id prefix "${prefix}" matches ${ids.length} Claude sessions: ${ids.join(", ")}. Pass more of the id.`
        );
        this.name = "AmbiguousSessionIdError";
    }
}

/** The shortest id prefix a lookup accepts, as `tools claude summarize` and the hub print a session id. */
const MIN_PREFIX = 8;

/**
 * The copies a Claude session id names, in any letter case: every file of the exact id; else, for a prefix of at least
 * eight characters, the files of the one id it starts. A prefix that starts two or more ids throws
 * {@link AmbiguousSessionIdError}: the copy order ranks copies of one session, never two sessions against each other.
 */
function claudeTranscriptCopies(
    sessionId: string,
    roots: Pick<HarnessRoots, "native">,
    { projectFolder, includeSubagents = false }: ClaudeTranscriptScope
): string[] {
    const wanted = sessionId.toLowerCase();
    const hits = roots.native.flatMap((root) =>
        findClaude(wanted, root, folderReads).filter(
            (hit) =>
                (includeSubagents || !isClaudeSubagentPath(hit.filePath)) &&
                (!projectFolder || relative(root, hit.filePath).split(sep)[0] === projectFolder)
        )
    );
    const exact = hits.filter((hit) => hit.sessionId.toLowerCase() === wanted);

    if (exact.length > 0 || wanted.length < MIN_PREFIX) {
        return exact.map((hit) => hit.filePath);
    }

    const prefixed = hits.filter((hit) => hit.sessionId.toLowerCase().startsWith(wanted));
    const ids = [...new Set(prefixed.map((hit) => hit.sessionId))].sort();

    if (ids.length > 1) {
        throw new AmbiguousSessionIdError(sessionId, ids);
    }

    return prefixed.map((hit) => hit.filePath);
}

/**
 * The transcript of a Claude session id (full, or a prefix of eight characters or more) that history discovery
 * indexes: one folder listing per root and discovery's own duplicate order (`preferTranscriptCopy`), not the newest
 * file or the first in folder order, which after a cwd move is often a title-only stub. Throws
 * {@link AmbiguousSessionIdError} for a prefix of several sessions.
 */
export async function canonicalClaudeTranscript(
    sessionId: string,
    roots: Pick<HarnessRoots, "native"> = claudeLocate.defaultRoots(),
    scope: ClaudeTranscriptScope = {}
): Promise<string | undefined> {
    return canonicalClaudeCopy(claudeTranscriptCopies(sessionId, roots, scope));
}

/**
 * {@link canonicalClaudeTranscript} for a synchronous caller (`NativeSessionReader.readChanges`, `tools agents
 * blame`): the same copies in the same order, so the two forms never answer different files, and the same
 * {@link AmbiguousSessionIdError} for a prefix of several sessions.
 */
export function canonicalClaudeTranscriptSync(
    sessionId: string,
    roots: Pick<HarnessRoots, "native"> = claudeLocate.defaultRoots(),
    scope: ClaudeTranscriptScope = {}
): string | undefined {
    return canonicalClaudeCopySync(claudeTranscriptCopies(sessionId, roots, scope));
}

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
 * A sub-agent transcript by its exact id: `<project>/<session>/subagents/agent-<id>.jsonl`, or the same file in one of
 * the session's Workflow tool run folders. Exact only, since every session directory is probed with one `existsSync`
 * (and one more per run folder, for the few sessions that have any).
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

            const candidates = claudeSubagentCandidates(join(projectDir, `${session}.jsonl`), agentId, (dir) =>
                fs.listDir(dir)
            );
            for (const { transcript: filePath } of candidates) {
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
