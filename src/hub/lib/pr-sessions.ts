import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ChangeEvent, sessionChangesPath } from "@app/agents/lib/changes/log";
import { createClaudeAdapter, createCodexAdapter, createGrokAdapter } from "@genesiscz/utils/agent-sessions";
import type { AgentSession } from "@genesiscz/utils/agent-sessions/types";
import { createGit, listWorktrees, type WorktreeInfo } from "@genesiscz/utils/git";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";

const log = logger.child({ component: "hub/pr-sessions" });

/** Why a session belongs to the PR, strongest first. */
export type PrSessionReason = "worktree" | "branch" | "commits" | "files";
const REASON_ORDER: PrSessionReason[] = ["worktree", "branch", "commits", "files"];

export interface PrSessionMatch {
    provider: string;
    sessionId: string;
    title: string | null;
    cwd: string;
    project: string | null;
    gitBranch: string | null;
    /** Last activity, ISO. */
    mtime: string;
    reasons: PrSessionReason[];
    /** PR files (repo-relative) the session's change log edited; at most `MAX_LISTED`. */
    files: string[];
    fileCount: number;
    /** PR commits whose `git commit` output is in the session's transcript. */
    commits: string[];
}

export interface PrSessionsResult {
    sessions: PrSessionMatch[];
    /** Every checkout of the repository that was searched. */
    checkouts: string[];
    since: string;
    warnings: string[];
    scanned: { indexed: number; changeLogs: number; transcripts: number };
    elapsedMs: number;
    cached: boolean;
}

export interface PrSessionsInput {
    /** Any checkout of the repository (the main one is found from it). */
    repoRoot: string;
    headBranch: string;
    /** The PR's base (recorded base commit, or `origin/<base>`); with `head`, names the PR's files. */
    base?: string | null;
    head?: string | null;
    /** The PR's commits; from `git log base..head` when not given. */
    commits?: string[];
    /** The PR's first activity (oldest commit or creation); a day before it bounds every scan. */
    since?: Date | null;
}

/** A session row from the shared history index. */
export interface IndexedSession {
    provider: string;
    sessionId: string;
    title: string | null;
    cwd: string;
    project: string | null;
    gitBranch: string | null;
    mtime: Date;
    filePath: string;
}

/** The I/O the matcher needs; tests replace it. */
export interface PrSessionsDeps {
    worktrees: (root: string) => Promise<WorktreeInfo[]>;
    changedFiles: (root: string, base: string, head: string) => Promise<string[]>;
    commitsBetween: (root: string, base: string, head: string) => Promise<string[]>;
    indexed: (since: Date) => Promise<IndexedSession[]>;
    changeLogs: (since: Date, roots: string[]) => ChangeEvent[];
    /** Short shas found in `git commit` output lines, per transcript path. */
    commitOutput: (files: string[], shas: string[]) => Promise<Map<string, Set<string>>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 90;
const MAX_CHANGE_LOGS = 400;
const MAX_TRANSCRIPTS = 300;
const MAX_RESULTS = 100;
const MAX_LISTED = 20;
const SHORT_SHA = 7;
const CACHE_TTL = "60 seconds";

function under(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
}

/** The checkout of `roots` that holds `path` (the deepest one: a worktree can sit inside the main checkout). */
export function checkoutOf(path: string, roots: string[]): string | null {
    let best: string | null = null;

    for (const root of roots) {
        if (under(path, root) && (!best || root.length > best.length)) {
            best = root;
        }
    }

    return best;
}

/**
 * The sessions that touched a PR: run in a checkout of its head branch, recorded its head branch in
 * a checkout of the repository, committed one of its commits, or edited one of its files. Every
 * scan is bounded by time (`since` minus a day) and count; nothing here writes or reaches the network.
 */
export async function matchPrSessions(input: PrSessionsInput, deps: PrSessionsDeps): Promise<PrSessionsResult> {
    const started = performance.now();
    const warnings: string[] = [];
    const since = new Date((input.since?.getTime() ?? Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS) - DAY_MS);

    const worktrees = await deps.worktrees(input.repoRoot).catch((error: unknown) => {
        warnings.push(`worktrees: ${error}`);
        return [] as WorktreeInfo[];
    });
    const checkouts = worktrees.length ? worktrees.map((wt) => wt.path) : [input.repoRoot];
    // Only a dedicated worktree names the branch by its folder. The main checkout switches branches,
    // so a session there counts through the branch its transcript recorded.
    const headCheckouts = worktrees.filter((wt) => !wt.isMain && wt.branch === input.headBranch).map((wt) => wt.path);

    let files: string[] = [];
    let commits = input.commits ?? [];

    if (input.base && input.head) {
        const { base, head } = input;
        [files, commits] = await Promise.all([
            deps.changedFiles(input.repoRoot, base, head).catch((error: unknown) => {
                warnings.push(`files: ${error}`);
                return [] as string[];
            }),
            commits.length
                ? Promise.resolve(commits)
                : deps.commitsBetween(input.repoRoot, base, head).catch((error: unknown) => {
                      warnings.push(`commits: ${error}`);
                      return [] as string[];
                  }),
        ]);
    }

    const indexed = await deps.indexed(since);
    const byId = new Map(indexed.map((session) => [session.sessionId, session]));
    const matches = new Map<
        string,
        { session: IndexedSession; reasons: Set<PrSessionReason>; files: Set<string>; commits: Set<string> }
    >();
    const entry = (session: IndexedSession) => {
        let found = matches.get(session.sessionId);

        if (!found) {
            found = { session, reasons: new Set(), files: new Set(), commits: new Set() };
            matches.set(session.sessionId, found);
        }

        return found;
    };

    const inRepo = indexed.filter((session) => checkoutOf(session.cwd, checkouts));

    for (const session of inRepo) {
        if (headCheckouts.some((root) => under(session.cwd, root))) {
            entry(session).reasons.add("worktree");
        } else if (session.gitBranch && session.gitBranch === input.headBranch) {
            entry(session).reasons.add("branch");
        }
    }

    const fileSet = new Set(files);
    const events = fileSet.size ? deps.changeLogs(since, checkouts) : [];

    for (const event of events) {
        const root = checkoutOf(event.path, checkouts);
        const relative = root ? event.path.slice(root.length + 1) : null;

        if (!relative || !fileSet.has(relative) || Date.parse(event.ts) < since.getTime()) {
            continue;
        }

        const session = byId.get(event.session) ?? {
            provider: event.provider,
            sessionId: event.session,
            title: null,
            cwd: event.cwd,
            project: null,
            gitBranch: null,
            mtime: new Date(event.ts),
            filePath: "",
        };
        const found = entry(session);
        found.reasons.add("files");
        found.files.add(relative);
    }

    const shas = [...new Set(commits.filter((sha) => sha.length >= SHORT_SHA))];
    const transcripts = inRepo
        .filter((session) => session.filePath)
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .slice(0, MAX_TRANSCRIPTS);

    if (shas.length && transcripts.length) {
        const found = await deps
            .commitOutput(
                transcripts.map((session) => session.filePath),
                shas
            )
            .catch((error: unknown) => {
                warnings.push(`commit search: ${error}`);
                return new Map<string, Set<string>>();
            });
        const byFile = new Map(transcripts.map((session) => [session.filePath, session]));

        for (const [file, shorts] of found) {
            const session = byFile.get(file);
            const full = shas.filter((sha) => [...shorts].some((short) => sha.startsWith(short)));

            if (session && full.length) {
                const hit = entry(session);
                hit.reasons.add("commits");
                for (const sha of full) {
                    hit.commits.add(sha);
                }
            }
        }
    }

    const rank = (reasons: Set<PrSessionReason>) =>
        Math.min(...[...reasons].map((reason) => REASON_ORDER.indexOf(reason)));
    const sessions = [...matches.values()]
        .sort((a, b) => rank(a.reasons) - rank(b.reasons) || b.session.mtime.getTime() - a.session.mtime.getTime())
        .slice(0, MAX_RESULTS)
        .map(({ session, reasons, files: edited, commits: committed }) => ({
            provider: session.provider,
            sessionId: session.sessionId,
            title: session.title,
            cwd: session.cwd,
            project: session.project,
            gitBranch: session.gitBranch,
            mtime: session.mtime.toISOString(),
            reasons: REASON_ORDER.filter((reason) => reasons.has(reason)),
            files: [...edited].sort().slice(0, MAX_LISTED),
            fileCount: edited.size,
            commits: [...committed],
        }));

    const result: PrSessionsResult = {
        sessions,
        checkouts,
        since: since.toISOString(),
        warnings,
        scanned: {
            indexed: indexed.length,
            changeLogs: new Set(events.map((event) => event.session)).size,
            transcripts: transcripts.length,
        },
        elapsedMs: Math.round(performance.now() - started),
        cached: false,
    };
    log.debug(
        {
            repo: input.repoRoot,
            branch: input.headBranch,
            found: sessions.length,
            scanned: result.scanned,
            ms: result.elapsedMs,
            warnings,
        },
        "pr sessions"
    );
    return result;
}

// ---------------------------------------------------------------------------
// Real I/O

async function indexedSessions(since: Date): Promise<IndexedSession[]> {
    const adapters = [createClaudeAdapter(), createCodexAdapter(), createGrokAdapter()];
    const lists = await Promise.all(
        adapters.map(async (adapter) => {
            const rows: AgentSession[] = (await adapter.listCached?.({ since })) ?? [];
            return rows
                .filter((row) => !row.isSubagent)
                .map((row) => ({
                    provider: adapter.kind,
                    sessionId: row.sessionId,
                    title: row.title || null,
                    cwd: row.cwd,
                    project: row.project ?? null,
                    gitBranch: row.gitBranch ?? null,
                    mtime: row.mtime,
                    filePath: row.filePath,
                }));
        })
    );
    return lists.flat();
}

/** Change-log events under `roots` from logs written since `since`, the newest logs first. */
function changeLogEvents(since: Date, roots: string[]): ChangeEvent[] {
    const dir = dirname(dirname(sessionChangesPath("probe")));
    let names: string[];

    try {
        names = readdirSync(dir).filter((name) => !name.startsWith("_"));
    } catch (error) {
        log.debug({ error, dir }, "no change logs");
        return [];
    }

    const logs: { path: string; mtime: number }[] = [];

    for (const name of names) {
        const path = join(dir, name, "changes.jsonl");

        try {
            const mtime = statSync(path).mtimeMs;

            if (mtime >= since.getTime()) {
                logs.push({ path, mtime });
            }
        } catch (error) {
            // A session directory without a change log (decisions only) is the common case.
            log.trace({ error, path }, "no change log");
        }
    }

    const events: ChangeEvent[] = [];

    for (const { path } of logs.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_CHANGE_LOGS)) {
        let text: string;

        try {
            text = readFileSync(path, "utf8");
        } catch (error) {
            log.debug({ error, path }, "change log unreadable");
            continue;
        }

        for (const line of text.split("\n")) {
            // Cheap gate before parsing: most lines of most logs are about other repositories.
            if (!line || !roots.some((root) => line.includes(root))) {
                continue;
            }

            try {
                events.push(SafeJSON.parse(line, { strict: true }) as ChangeEvent);
            } catch (error) {
                log.debug({ error, path }, "change log line unreadable");
            }
        }
    }

    return events;
}

/** The sha in one match of `commitOutputPattern`: after `[branch ` or after `old..`. */
const COMMIT_OUTPUT_SHA = /(?:\[[^\]]* |\.\.)([0-9a-f]{7,40})(?:\]| )$/;

/**
 * What a session prints when it made a commit: `git commit`'s `[branch abc1234] title`, and
 * `git push`'s `old..new  branch -> branch`. A plain `git log` line is not evidence: any session
 * that only read the history prints those.
 */
export function commitOutputPattern(shas: string[]): string {
    const prefixes = [...new Set(shas.map((sha) => sha.slice(0, SHORT_SHA)))];
    return `(\\[[^\\]\\n"]{1,200} |[0-9a-f]{7,40}\\.\\.)(${prefixes.join("|")})[0-9a-f]{0,33}(\\]| )`;
}

/** The sha of one `commitOutputPattern` match. */
export function commitOutputSha(match: string): string | null {
    return COMMIT_OUTPUT_SHA.exec(match)?.[1] ?? null;
}

/**
 * Short shas of commit and push output in the transcripts, one ripgrep over every file. Only the
 * PR's own shas are searched for, so the output stays small.
 */
async function commitOutputShas(files: string[], shas: string[]): Promise<Map<string, Set<string>>> {
    const pattern = commitOutputPattern(shas);
    const proc = Bun.spawn(
        ["rg", "--no-config", "-o", "--null", "--no-line-number", "--with-filename", "-e", pattern, "--", ...files],
        {
            stdout: "pipe",
            stderr: "pipe",
        }
    );
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    // 1 = no match anywhere; 2 = an error, which a missing (rotated) transcript also causes.
    if (code === 2 && !stdout) {
        throw new Error(stderr.trim().split("\n")[0] || "rg failed");
    }

    const found = new Map<string, Set<string>>();

    for (const line of stdout.split("\n")) {
        const nul = line.indexOf("\0");
        const sha = nul > 0 ? commitOutputSha(line.slice(nul + 1)) : null;

        if (sha) {
            const file = line.slice(0, nul);
            const set = found.get(file) ?? new Set<string>();
            set.add(sha);
            found.set(file, set);
        }
    }

    return found;
}

export const realPrSessionsDeps: PrSessionsDeps = {
    worktrees: (root) => listWorktrees(root),
    changedFiles: async (root, base, head) => {
        const git = createGit({ cwd: root });
        const from = await git.mergeBase(base, head);
        const entries = await git.nameStatus({ from, to: head });
        return entries.map((entry) => entry.path);
    },
    commitsBetween: async (root, base, head) => {
        const entries = await createGit({ cwd: root }).log({ range: `${base}..${head}`, limit: 250 });
        return entries.map((entry) => entry.sha);
    },
    indexed: indexedSessions,
    changeLogs: changeLogEvents,
    commitOutput: commitOutputShas,
};

/** `matchPrSessions` behind a 60 s cache keyed by the whole input; `fresh` skips the read. */
export async function prSessions({
    input,
    fresh = false,
    deps = realPrSessionsDeps,
}: {
    input: PrSessionsInput;
    fresh?: boolean;
    deps?: PrSessionsDeps;
}): Promise<PrSessionsResult> {
    const storage = new Storage("hub");
    const key = `pr-sessions/${createHash("sha256").update(SafeJSON.stringify(input)).digest("hex").slice(0, 24)}.json`;

    if (!fresh) {
        const hit = await storage.getCacheFile<PrSessionsResult>(key, CACHE_TTL);

        if (hit) {
            return { ...hit, cached: true };
        }
    }

    const result = await matchPrSessions(input, deps);
    await storage.putCacheFile(key, result, CACHE_TTL);
    return result;
}
