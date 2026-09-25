import { createHash } from "node:crypto";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { type DecisionRecord, readDecisions } from "@app/question/lib/decisions/store";
import {
    allTranscriptTurns,
    cleanTranscriptText,
    type ResolvedTranscript,
    resolveTranscript,
    type TranscriptTurn,
    totalsOf,
} from "@genesiscz/utils/ai/transcripts";
import { listSubagents, type SessionSubagent } from "@genesiscz/utils/ai/transcripts/subagents";
import { LOG_FORMAT, parseLogZ, parseNameStatusZ, parseNumstatZ } from "@genesiscz/utils/git/porcelain";
import { logger } from "@genesiscz/utils/logger";
import { type ComputedSessionChanges, loadSessionChanges, mergeTurnFiles } from "@genesiscz/utils/session-changes";
import type { Storage } from "@genesiscz/utils/storage";
import { backendFor, type PrThread, prThreads, resolvePr, type ThreadsResult } from "./pr";
import { type HubPr, type HubPrDetail, hubPr } from "./prs";
import { type RepoFacts, repoFacts } from "./repo";
import { cachedPrs, cachedThreads, commentTitle, git, hubStorage, startOfDay } from "./timeline";

const log = logger.child({ component: "hub/timeline-detail" });

/**
 * `tools hub timeline detail`: what a folded-open Activity row shows. One loader per kind, each
 * bounded and cached, so the hub never reads a transcript or runs git on its own.
 */

export const TIMELINE_DETAIL_KINDS = ["session", "commit", "push", "pr", "thread", "decision", "ci"] as const;
export type TimelineDetailKind = (typeof TIMELINE_DETAIL_KINDS)[number];

export const DETAIL_LIMITS = { prompts: 30, files: 60, branches: 20, pushCommits: 100, diffLines: 400, newThreads: 20 };

export interface TimelineDetailRequest {
    kind: TimelineDetailKind;
    /** The row's id (`commit:<sha>`, `turn:<session>`, `thread:<comment>`, …) or the bare key. */
    id: string;
    /** The repository (commit, push). */
    repo?: string;
    /** The PR/MR URL (pr, ci, thread). */
    pr?: string;
    /** The session id when the id does not carry it. */
    session?: string;
    /** A push's old tip. */
    from?: string;
    /** The period a session row stands for (default: today). */
    since?: Date;
    until?: Date;
    /** A commit's one file whose diff is wanted. */
    file?: string;
    fresh?: boolean;
}

export interface TimelinePrSummary {
    ref: string;
    url: string;
    title: string;
    state: string;
}

export interface SessionDetail {
    kind: "session";
    sessionId: string;
    provider: string;
    filePath: string | null;
    since: string;
    until: string;
    /** Turns of the period. */
    turns: number;
    prompts: Array<{ index: number; at: string | null; text: string }>;
    promptsTotal: number;
    lastReply: { at: string | null; text: string } | null;
    files: Array<{ path: string; via: string; edits: number; agents: number }>;
    filesTotal: number;
    subagents: Array<{
        id: string;
        name: string | null;
        description: string | null;
        agentType: string | null;
        state: string;
        lastAt: string;
    }>;
    tokens: { calls: number; input: number; cacheRead: number; output: number };
    /** What the transcript itself recorded (worker runs); null when the provider writes no cost. */
    costUsd: number | null;
    warnings: string[];
}

export interface CommitDetail {
    kind: "commit";
    sha: string;
    shortSha: string;
    subject: string;
    body: string;
    author: string;
    email: string;
    at: string;
    files: Array<{ path: string; status: string; added: number; removed: number; binary: boolean }>;
    branches: string[];
    branchesTruncated: boolean;
    prs: TimelinePrSummary[];
    diff: { path: string; text: string; truncated: boolean } | null;
}

export interface PushDetail {
    kind: "push";
    branch: string;
    from: string;
    to: string;
    newBranch: boolean;
    commits: Array<{ sha: string; shortSha: string; subject: string; at: string; author: string }>;
    truncated: boolean;
    remote: { kind: string | null; web: string | null } | null;
    pr: TimelinePrSummary | null;
}

export interface PrEventDetail {
    kind: "pr";
    pr: {
        ref: string;
        url: string;
        title: string;
        state: string;
        draft: boolean;
        author: string | null;
        headBranch: string;
        baseBranch: string;
        additions: number | null;
        deletions: number | null;
        changedFiles: number | null;
        mergeable: string | null;
        reviewDecision: string | null;
        approvals: number | null;
        ci: string | null;
        checks: Array<{ name: string; status: string | null; url: string | null }>;
        webUrls: { pr: string; files: string; commits: string; checks: string } | null;
        localWorktree: string | null;
        repoRoot: string | null;
    };
    threads: {
        total: number;
        open: number;
        newSince: Array<{
            id: string;
            threadId: string;
            path: string;
            line: number;
            author: string;
            title: string;
            at: string;
            resolved: boolean;
        }>;
    };
    warnings: string[];
}

export interface ThreadDetail {
    kind: "thread";
    pr: TimelinePrSummary;
    viewer: string | null;
    thread: PrThread;
    fetched: "cache" | "host";
}

export interface DecisionDetail {
    kind: "decision";
    record: DecisionRecord;
}

export type TimelineDetail = SessionDetail | CommitDetail | PushDetail | PrEventDetail | ThreadDetail | DecisionDetail;

export class TimelineDetailError extends Error {}

export interface TimelineDetailDeps {
    git: (args: string[], cwd: string) => Promise<string>;
    transcript: (sessionId: string) => Promise<{ resolved: ResolvedTranscript; turns: TranscriptTurn[] }>;
    /** null when the session has no transcript this machine can read (Grok, a deleted one). */
    changes: (sessionId: string) => ComputedSessionChanges | null;
    subagents: (resolved: ResolvedTranscript) => SessionSubagent[];
    /** The cached PR list of these projects. */
    prs: (roots: string[]) => Promise<HubPr[]>;
    /** Every cached thread list (no network). */
    threads: () => ThreadsResult[];
    /** The threads of one PR from the host (its own 30 s cache). */
    fetchThreads: (pr: string, repo: string | null) => Promise<ThreadsResult>;
    prDetail: (ref: string) => Promise<HubPrDetail>;
    decisions: () => DecisionRecord[];
    facts: (path: string) => Promise<RepoFacts>;
}

function keyOf(id: string): string {
    const colon = id.indexOf(":");
    return colon >= 0 ? id.slice(colon + 1) : id;
}

function shortSha(sha: string): string {
    return sha.slice(0, 8);
}

/** A prompt or reply as one readable excerpt: harness wrappers and tags out, whitespace folded. */
function excerpt(text: string, max: number): string {
    const clean = cleanTranscriptText(text, { dropStatusLines: true, slashFallback: false })
        .replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function prSummary(pr: HubPr): TimelinePrSummary {
    const project = pr.origin.web ? new URL(pr.origin.web).pathname.replace(/^\/+|\/+$/g, "") : pr.repo;
    const mark = pr.origin.kind === "gitlab" ? "!" : "#";
    return { ref: `${project || pr.repo}${mark}${pr.number}`, url: pr.url, title: pr.title, state: pr.state };
}

function threadPrSummary(result: ThreadsResult): TimelinePrSummary {
    const { pr } = result;
    const mark = pr.provider === "gitlab" ? "!" : "#";
    return { ref: `${pr.project}${mark}${pr.number}`, url: pr.webUrl || pr.url, title: pr.title, state: pr.state };
}

function samePr(result: ThreadsResult, url: string): boolean {
    const wanted = url.replace(/\/+$/, "");
    return result.pr.url.replace(/\/+$/, "") === wanted || result.pr.webUrl.replace(/\/+$/, "") === wanted;
}

function within(at: string | null | undefined, since: Date, until: Date): boolean {
    if (!at) {
        return false;
    }

    const ms = Date.parse(at);
    return Number.isFinite(ms) && ms >= since.getTime() && ms <= until.getTime();
}

// MARK: - Loaders

async function sessionDetail(
    request: TimelineDetailRequest,
    deps: TimelineDetailDeps,
    now: Date
): Promise<SessionDetail> {
    const sessionId = request.session ?? keyOf(request.id);
    const since = request.since ?? startOfDay(now);
    const until = request.until ?? now;
    const warnings: string[] = [];
    const { resolved, turns } = await deps.transcript(sessionId);
    const period = turns.map((turn, index) => ({ turn, index })).filter(({ turn }) => within(turn.at, since, until));
    const prompts = period
        .filter(({ turn }) => turn.role === "user")
        .map(({ turn, index }) => ({ index, at: turn.at, text: excerpt(turn.text, 400) }))
        .filter((prompt) => prompt.text.length > 0);
    const reply = [...period].reverse().find(({ turn }) => turn.role === "assistant" && turn.text.trim().length > 0);
    const totals = totalsOf(period.map(({ turn }) => turn));

    let files: SessionDetail["files"] = [];
    let filesTotal = 0;

    try {
        const changes = deps.changes(sessionId);

        if (changes) {
            const merged = mergeTurnFiles(changes.turns.filter((turn) => within(turn.at, since, until)));
            filesTotal = merged.length;
            // The most edited first; among equals the session's own files before scratch ones.
            files = merged
                .map((file) => ({
                    path: file.path,
                    via: file.via,
                    edits: file.toolUseIds.length,
                    agents: file.agentIds?.length ?? 0,
                }))
                .sort(
                    (a, b) =>
                        b.edits - a.edits ||
                        Number(a.path.startsWith("/tmp")) - Number(b.path.startsWith("/tmp")) ||
                        a.path.localeCompare(b.path)
                )
                .slice(0, DETAIL_LIMITS.files);
        }
    } catch (error) {
        warnings.push(`files: ${error instanceof Error ? error.message : String(error)}`);
        log.warn({ error, sessionId }, "timeline detail: session changes failed");
    }

    const subagents = deps
        .subagents(resolved)
        .filter((agent) => within(agent.lastAt, since, until) || within(agent.startedAt, since, until))
        .map((agent) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description,
            agentType: agent.agentType,
            state: agent.state,
            lastAt: agent.lastAt,
        }));

    return {
        kind: "session",
        sessionId,
        provider: resolved.provider,
        filePath: resolved.filePath || null,
        since: since.toISOString(),
        until: until.toISOString(),
        turns: period.length,
        prompts: prompts.slice(-DETAIL_LIMITS.prompts),
        promptsTotal: prompts.length,
        lastReply: reply ? { at: reply.turn.at, text: excerpt(reply.turn.text, 600) } : null,
        files,
        filesTotal,
        subagents,
        tokens: {
            calls: totals.modelCalls,
            input: totals.inputTokens ?? 0,
            cacheRead: totals.cacheReadTokens ?? 0,
            output: totals.outputTokens ?? 0,
        },
        costUsd: totals.costUsd ?? null,
        warnings,
    };
}

async function containingPrs(
    repo: string,
    branches: readonly string[],
    deps: TimelineDetailDeps
): Promise<TimelinePrSummary[]> {
    const names = new Set(branches.map((name) => name.replace(/^(remotes\/)?[^/]+\//, "")).concat(branches));

    try {
        return (await deps.prs([repo])).filter((pr) => names.has(pr.headBranch)).map(prSummary);
    } catch (error) {
        log.debug({ error, repo }, "timeline detail: PR list unavailable");
        return [];
    }
}

async function commitDetail(request: TimelineDetailRequest, deps: TimelineDetailDeps): Promise<CommitDetail> {
    const sha = keyOf(request.id);
    const repo = request.repo;

    if (!repo) {
        throw new TimelineDetailError("--repo is required for a commit");
    }

    const [logText, numstatText, statusText, branchText] = await Promise.all([
        deps.git(["show", "-s", "-z", LOG_FORMAT, sha], repo),
        deps.git(["show", "--format=", "--numstat", "-z", sha], repo),
        deps.git(["show", "--format=", "--name-status", "-z", sha], repo),
        deps.git(["branch", "-a", "--contains", sha, "--format=%(refname:short)"], repo),
    ]);
    const commit = parseLogZ(logText)[0];

    if (!commit) {
        throw new TimelineDetailError(`git knows no commit ${sha} in ${repo}`);
    }

    const status = new Map(parseNameStatusZ(statusText).map((entry) => [entry.path, entry.status]));
    const files = parseNumstatZ(numstatText).map((entry) => ({
        path: entry.path,
        status: status.get(entry.path) ?? "M",
        added: entry.insertions,
        removed: entry.deletions,
        binary: entry.binary,
    }));
    const allBranches = branchText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.endsWith("/HEAD"));
    const branches = allBranches.slice(0, DETAIL_LIMITS.branches);
    let diff: CommitDetail["diff"] = null;

    if (request.file) {
        const text = await deps.git(["show", "--format=", "--unified=3", sha, "--", request.file], repo);
        const lines = text.split("\n");
        diff = {
            path: request.file,
            text: lines.slice(0, DETAIL_LIMITS.diffLines).join("\n"),
            truncated: lines.length > DETAIL_LIMITS.diffLines,
        };
    }

    return {
        kind: "commit",
        sha: commit.sha,
        shortSha: shortSha(commit.sha),
        subject: commit.subject,
        body: commit.body.trim(),
        author: commit.author.name,
        email: commit.author.email,
        at: new Date(commit.committer.epoch * 1000).toISOString(),
        files,
        branches,
        branchesTruncated: allBranches.length > branches.length,
        prs: await containingPrs(repo, allBranches, deps),
        diff,
    };
}

async function pushDetail(request: TimelineDetailRequest, deps: TimelineDetailDeps): Promise<PushDetail> {
    const repo = request.repo;

    if (!repo) {
        throw new TimelineDetailError("--repo is required for a push");
    }

    // `push:<branch>:<to>:<at>`; the branch may contain colons only in theory, the sha never does.
    const parts = keyOf(request.id).split(":");
    const to = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
    const branch = parts.length >= 3 ? parts.slice(0, parts.length - 2).join(":") : "";
    const from = request.from ?? "";
    const newBranch = !from || /^0+$/.test(from);
    const range = newBranch ? [to] : [`${from}..${to}`];
    const text = await deps.git(["log", "-z", LOG_FORMAT, `-${DETAIL_LIMITS.pushCommits + 1}`, ...range], repo);
    const parsed = parseLogZ(text);
    const commits = parsed.slice(0, newBranch ? 50 : DETAIL_LIMITS.pushCommits).map((commit) => ({
        sha: commit.sha,
        shortSha: shortSha(commit.sha),
        subject: commit.subject,
        at: new Date(commit.committer.epoch * 1000).toISOString(),
        author: commit.author.name,
    }));
    let remote: PushDetail["remote"] = null;

    try {
        const facts = await deps.facts(repo);
        remote = facts.origin ? { kind: facts.origin.kind, web: facts.origin.web } : null;
    } catch (error) {
        log.debug({ error, repo }, "timeline detail: repo facts unavailable");
    }

    let pr: TimelinePrSummary | null = null;

    try {
        const match = (await deps.prs([repo])).find((row) => row.headBranch === branch);
        pr = match ? prSummary(match) : null;
    } catch (error) {
        log.debug({ error, repo }, "timeline detail: PR list unavailable");
    }

    return {
        kind: "push",
        branch,
        from,
        to,
        newBranch,
        commits,
        truncated: parsed.length > commits.length,
        remote,
        pr,
    };
}

async function prEventDetail(
    request: TimelineDetailRequest,
    deps: TimelineDetailDeps,
    now: Date
): Promise<PrEventDetail> {
    const url = request.pr;

    if (!url) {
        throw new TimelineDetailError("--pr <url> is required for a PR event");
    }

    const since = request.since ?? startOfDay(now);
    const until = request.until ?? now;
    const detail = await deps.prDetail(url);
    const cached = deps.threads().find((result) => samePr(result, url));
    const newSince: PrEventDetail["threads"]["newSince"] = [];

    for (const thread of cached?.threads ?? []) {
        for (const comment of thread.comments) {
            if (comment.isDraft || !within(comment.createdAt, since, until)) {
                continue;
            }

            newSince.push({
                id: comment.id,
                threadId: thread.id,
                path: thread.path,
                line: thread.line,
                author: comment.author.username || comment.author.name,
                title: commentTitle(comment.bodyMarkdown),
                at: comment.createdAt,
                resolved: thread.resolved,
            });
        }
    }

    newSince.sort((a, b) => b.at.localeCompare(a.at));
    const summary = prSummary(detail);
    return {
        kind: "pr",
        pr: {
            ref: summary.ref,
            url: detail.url,
            title: detail.title,
            state: detail.state,
            draft: detail.draft,
            author: detail.author,
            headBranch: detail.headBranch,
            baseBranch: detail.baseBranch,
            additions: detail.additions,
            deletions: detail.deletions,
            changedFiles: detail.changedFiles,
            mergeable: detail.mergeable,
            reviewDecision: detail.reviewDecision,
            approvals: detail.approvals,
            ci: detail.ci,
            checks: detail.checks.map((check) => ({ name: check.name, status: check.status, url: check.url })),
            webUrls: detail.webUrls ?? null,
            localWorktree: detail.localWorktree,
            repoRoot: detail.repoRoot,
        },
        threads: {
            total: cached?.threads.length ?? 0,
            open: cached?.threads.filter((thread) => !thread.resolved).length ?? 0,
            newSince: newSince.slice(0, DETAIL_LIMITS.newThreads),
        },
        warnings: detail.warnings,
    };
}

async function threadDetail(request: TimelineDetailRequest, deps: TimelineDetailDeps): Promise<ThreadDetail> {
    const url = request.pr;

    if (!url) {
        throw new TimelineDetailError("--pr <url> is required for a review comment");
    }

    const commentId = keyOf(request.id);
    const find = (result: ThreadsResult | undefined) =>
        result?.threads.find(
            (thread) => thread.id === commentId || thread.comments.some((comment) => comment.id === commentId)
        );
    const cached = request.fresh ? undefined : deps.threads().find((result) => samePr(result, url));
    const hit = find(cached);

    if (cached && hit) {
        return { kind: "thread", pr: threadPrSummary(cached), viewer: cached.viewer, thread: hit, fetched: "cache" };
    }

    const fetched = await deps.fetchThreads(url, request.repo ?? null);
    const thread = find(fetched);

    if (!thread) {
        throw new TimelineDetailError(`comment ${commentId} is not on ${url} any more`);
    }

    return { kind: "thread", pr: threadPrSummary(fetched), viewer: fetched.viewer, thread, fetched: "host" };
}

function decisionDetail(request: TimelineDetailRequest, deps: TimelineDetailDeps): DecisionDetail {
    const id = keyOf(request.id);
    const record = deps.decisions().find((row) => row.id === id);

    if (!record) {
        throw new TimelineDetailError(`no decision ${id} in the store`);
    }

    return { kind: "decision", record };
}

// MARK: - Entry

const DETAIL_TTL: Record<TimelineDetailKind, string | null> = {
    session: "1 minute",
    commit: "1 day",
    push: "1 day",
    pr: "1 minute",
    ci: "1 minute",
    thread: "30 seconds",
    decision: null,
};

export const realTimelineDetailDeps: TimelineDetailDeps = {
    git: (args, cwd) => git(args, cwd),
    transcript: async (sessionId) => {
        const resolved = await resolveTranscript(sessionId);
        return { resolved, turns: await allTranscriptTurns(resolved) };
    },
    changes: (sessionId) => {
        const loaded = loadSessionChanges({ sessionId });
        return loaded.transcriptPath ? loaded : null;
    },
    subagents: (resolved) => listSubagents(resolved).subagents,
    prs: cachedPrs,
    threads: cachedThreads,
    fetchThreads: async (pr, repo) => {
        const found = await resolvePr({ repo: repo ?? process.cwd(), pr });
        return prThreads({ pr: found, backend: await backendFor(found) });
    },
    prDetail: (ref) => hubPr({ ref }),
    decisions: () => readDecisions(decisionFiles().file),
    facts: (path) => repoFacts({ path }),
};

/** One row's detail, from its cache unless `fresh` (a commit's for a day, a session's for a minute). */
export async function timelineDetail({
    request,
    deps = realTimelineDetailDeps,
    storage = hubStorage(),
    now = new Date(),
}: {
    request: TimelineDetailRequest;
    deps?: TimelineDetailDeps;
    storage?: Storage;
    now?: Date;
}): Promise<TimelineDetail & { cached: boolean; elapsedMs: number }> {
    const started = performance.now();
    const ttl = DETAIL_TTL[request.kind];
    const fingerprint = createHash("sha1")
        .update(
            [
                request.kind,
                request.id,
                request.repo ?? "",
                request.pr ?? "",
                request.session ?? "",
                request.from ?? "",
                request.since?.toISOString() ?? "",
                request.until?.toISOString() ?? "",
                request.file ?? "",
            ].join("\n")
        )
        .digest("hex")
        .slice(0, 16);
    const key = `timeline/detail-${request.kind}-${fingerprint}.json`;

    if (ttl && !request.fresh) {
        const hit = await storage.getCacheFile<TimelineDetail>(key, ttl);

        if (hit) {
            return { ...hit, cached: true, elapsedMs: Math.round(performance.now() - started) };
        }
    }

    let detail: TimelineDetail;

    switch (request.kind) {
        case "session":
            detail = await sessionDetail(request, deps, now);
            break;
        case "commit":
            detail = await commitDetail(request, deps);
            break;
        case "push":
            detail = await pushDetail(request, deps);
            break;
        case "pr":
        case "ci":
            detail = await prEventDetail(request, deps, now);
            break;
        case "thread":
            detail = await threadDetail(request, deps);
            break;
        case "decision":
            detail = decisionDetail(request, deps);
            break;
    }

    if (ttl) {
        await storage.putCacheFile(key, detail, ttl);
    }

    const elapsedMs = Math.round(performance.now() - started);
    log.debug({ kind: request.kind, id: request.id, elapsedMs }, "timeline detail built");
    return { ...detail, cached: false, elapsedMs };
}
