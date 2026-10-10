import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
    type AgentSessionRow,
    listAgentSessionRows,
    POLLED_LISTING_REUSE_MS,
} from "@app/ai/lib/sessions/agent-session-rows";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { type DecisionRecord, readDecisions } from "@app/question/lib/decisions/store";
import { cleanSessionTitle } from "@genesiscz/utils/agent-sessions/user-text";
import { concurrentMap } from "@genesiscz/utils/async";
import { startOfDay } from "@genesiscz/utils/date";
import { type CommandRunner, spawnRunner } from "@genesiscz/utils/git/origins";
import { type CommitInfo, LOG_FORMAT_WITH_SOURCE, parseLogZ } from "@genesiscz/utils/git/porcelain";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { Storage } from "@genesiscz/utils/storage";
import { cached, capMaxCacheAge } from "@genesiscz/utils/storage/cache-flag";
import type { NotifyItem } from "./notify";
import { readNotifyState } from "./notify-poll";
import type { ThreadsResult } from "./pr";
import { type HubPr, hubPrs } from "./prs";

const log = logger.child({ component: "hub/timeline" });
const prof = profiler.scope("hub-timeline");

/**
 * Activity in one feed: sessions (start, last turn), commits, pushes, PR events, review comments,
 * decisions and CI results, across every project a session of the range worked in. Every source
 * is bounded to one page, the page is cut where a bounded source ran out (so an older page never
 * skips anything), the PR list (the only network call) is cached for five minutes, the live page
 * for one minute and an older page for ten.
 */

export type TimelineKind = "session.start" | "session.turn" | "commit" | "push" | "pr" | "thread" | "decision" | "ci";

export const TIMELINE_KINDS: readonly TimelineKind[] = [
    "session.start",
    "session.turn",
    "commit",
    "push",
    "pr",
    "thread",
    "decision",
    "ci",
];

export interface TimelinePrRef {
    /** `<project>#<n>`: the hub's `--pr` form. */
    ref: string;
    number: number;
    url: string;
}

export interface TimelineEvent {
    id: string;
    kind: TimelineKind;
    /** ISO time. */
    at: string;
    title: string;
    detail: string | null;
    project: string | null;
    /** The repository's main checkout. */
    repo: string | null;
    sessionId?: string;
    provider?: string;
    sha?: string;
    branch?: string;
    author?: string;
    pr?: TimelinePrRef;
    url?: string;
    /** Authored by me: a session, a commit by the checkout's user, a push, my PR, my comment, a decision I answer. */
    mine?: boolean;
    /** An open decision, failed CI on my PR, or an unresolved thread on my PR whose last word is not mine. */
    needsMe?: boolean;
    /** A push's old tip (all zeros for a new branch). */
    fromSha?: string;
    /** A session's folder. */
    cwd?: string;
    /** PR: OPEN, MERGED, CLOSED. CI: failed, success. Decision: its state. Thread: open, resolved. */
    state?: string;
    /** The PR's current CI status on a PR event, when the host reported one. */
    ci?: string | null;
    /** A review comment's thread, and where it sits. */
    threadId?: string;
    path?: string;
    line?: number;
    /** A commit row that stands for its copies on other branches (cherry-picked or rebased): those copies. */
    alsoOn?: TimelineCopy[];
}

/** One folded copy of a commit: its sha and the branch the log reached it by (null when no branch did). */
export interface TimelineCopy {
    sha: string;
    branch: string | null;
}

/** What `foldCopies` needs to know about the candidate commits of one repository. */
export interface CommitCopyFacts {
    /** `git patch-id --stable` by sha; a merge or an empty commit has none. */
    patchIds: ReadonlyMap<string, string>;
    /** The candidates the checked-out branch (the main checkout's HEAD) holds. */
    onHead: ReadonlySet<string>;
}

export interface TimelineResult {
    since: string;
    until: string;
    /** The page's inclusive upper bound when it is an older page; null for the live page. */
    before: string | null;
    limit: number;
    events: TimelineEvent[];
    repos: string[];
    counts: Record<TimelineKind, number>;
    warnings: string[];
    elapsedMs: number;
    cached: boolean;
    /** Older events exist in the range: ask again with `before = nextBefore`. */
    hasMore: boolean;
    nextBefore: string | null;
    /** The sources that hit the page limit inside this window (the page was cut at their oldest event). */
    truncated: string[];
}

/** Hard bounds: a busy day still answers in about a second, and a page never exceeds `pageMax`. */
export const TIMELINE_LIMITS = { repos: 25, pageDefault: 300, pageMax: 1000, prsPerProject: 30, prsInRange: 100 };

/** A page that ends this close to "now" is the live page (its cache key and its 1-minute cap). */
const TIMELINE_LIVE_SLACK_MS = 15_000;

export const TIMELINE_RANGE_PRESETS = ["hour", "24h", "today", "yesterday", "7d", "30d"] as const;
export type TimelineRangePreset = (typeof TIMELINE_RANGE_PRESETS)[number];
/** The range without `--range`: a rolling day, so just after midnight the feed is not nearly empty. */
export const TIMELINE_DEFAULT_RANGE: TimelineRangePreset = "24h";

export const TIMELINE_AUTHORS = ["all", "me", "others"] as const;
export type TimelineAuthor = (typeof TIMELINE_AUTHORS)[number];

/** Filters the page is built with, so a page of "mine" is a full page and not a sieve over one. */
export interface TimelineFilters {
    author?: TimelineAuthor;
    /** Only rows that wait for me: open decisions, failed CI on my PRs, unanswered threads on my PRs. */
    needsMe?: boolean;
    /** Only these kinds; undefined or empty = every kind. */
    kinds?: readonly TimelineKind[];
}

/** The inclusive window one page reads: `since` up to `upper` (the range end, or the cursor of an older page). */
export interface TimelineWindow {
    since: Date;
    upper: Date;
}

export interface RepoRef {
    /** The main checkout (the common dir's parent); worktrees of one repository collapse to it. */
    root: string;
    commonDir: string;
}

export type TimelineNotifyItem = NotifyItem & { at: string; posted: boolean };

export interface TimelineDeps {
    sessions: (hours: number) => Promise<AgentSessionRow[]>;
    /** When the session file was created, or null. */
    birth: (path: string) => number | null;
    /** The branch the session's newest recorded turn ran on (a bounded read of the file's tail), or null. */
    lastBranch: (path: string) => string | null;
    repoOf: (cwd: string) => Promise<RepoRef | null>;
    /**
     * `git log -z LOG_FORMAT_WITH_SOURCE` output of the window's commits on every ref (newest `limit`;
     * only the checkout user's when `author` is "me"), and the checkout's user email.
     */
    commits: (
        repo: RepoRef,
        window: TimelineWindow,
        limit: number,
        author: TimelineAuthor
    ) => Promise<{ log: string; email: string }>;
    /**
     * For commits that may be copies of one another (`copyCandidates`): their patch-ids (one batched
     * `diff-tree | patch-id` for the shas not cached yet) and which of them the checked-out branch holds.
     */
    commitCopies: (repo: RepoRef, shas: string[], window: TimelineWindow) => Promise<CommitCopyFacts>;
    /** The raw lines of every remote-tracking reflog, with the branch each belongs to. */
    remoteLogs: (repo: RepoRef) => Array<{ branch: string; lines: string[] }>;
    /**
     * The PRs of these projects updated since `since`, asked of the host in update order with that
     * bound (not the newest 30 of all time, which left out older PRs of a 30-day range), at most
     * `limit` per project, from a cache at most `maxCacheAgeSeconds` old (its own five minutes when unset).
     */
    prs: (roots: string[], since: Date, limit: number, maxCacheAgeSeconds?: number) => Promise<HubPr[]>;
    /** Every cached thread list the hub has fetched (no network). */
    threads: () => ThreadsResult[];
    /** The decision store's rows (`tools question`). */
    decisions: () => DecisionRecord[];
    /** What the PR notifier posted or recorded, newest last (CI results carry a real time only here). */
    notifyItems: () => TimelineNotifyItem[];
}

/** A named range: the last hour or 24 hours, today, yesterday, the last 7 or 30 days (ending now, or at midnight for yesterday). */
export function resolveRange(preset: TimelineRangePreset, now = new Date()): { since: Date; until: Date } {
    const today = startOfDay(now);

    switch (preset) {
        case "hour":
            return { since: new Date(now.getTime() - 3_600_000), until: now };
        case "24h":
            return { since: new Date(now.getTime() - 86_400_000), until: now };
        case "today":
            return { since: today, until: now };
        case "yesterday": {
            const since = new Date(today);
            since.setDate(since.getDate() - 1);
            return { since, until: new Date(today.getTime() - 1) };
        }
        case "7d":
        case "30d": {
            const since = new Date(today);
            since.setDate(since.getDate() - (preset === "7d" ? 6 : 29));
            return { since, until: now };
        }
    }
}

function iso(ms: number): string {
    return new Date(ms).toISOString();
}

function short(sha: string): string {
    return sha.slice(0, 8);
}

function inWindow(ms: number, window: TimelineWindow): boolean {
    return Number.isFinite(ms) && ms >= window.since.getTime() && ms <= window.upper.getTime();
}

function cut(text: string, max: number): string {
    const one = text.replace(/\s+/g, " ").trim();
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * Reflog lines `old new Name <email> 1790000000 +0200\tupdate by push`: the pushes at or after
 * `since` (and at or before `until` when given), oldest first. Fetches and other updates are not pushes.
 */
export function parsePushes(
    lines: readonly string[],
    since: Date,
    until?: Date
): Array<{ from: string; to: string; at: number }> {
    const pushes: Array<{ from: string; to: string; at: number }> = [];

    for (const line of lines) {
        const tab = line.indexOf("\t");

        if (tab < 0 || !line.slice(tab + 1).startsWith("update by push")) {
            continue;
        }

        const match = /^([0-9a-f]+) ([0-9a-f]+) .*> (\d+) [+-]\d{4}$/.exec(line.slice(0, tab));
        const seconds = match ? Number(match[3]) : Number.NaN;

        if (
            !match?.[1] ||
            !match[2] ||
            !Number.isFinite(seconds) ||
            seconds * 1000 < since.getTime() ||
            (until !== undefined && seconds * 1000 > until.getTime())
        ) {
            continue;
        }

        pushes.push({ from: match[1], to: match[2], at: seconds * 1000 });
    }

    return pushes;
}

/**
 * One bounded source's events (after the filters), newest first, whether it hit the page limit
 * inside the window, and the oldest event it read (below that it is incomplete when truncated).
 */
export interface SourceEvents {
    name: string;
    events: TimelineEvent[];
    truncated: boolean;
    oldestAt: string | null;
}

/** Whether the filters keep an event. An unknown author counts as someone else. */
export function keepsEvent(event: TimelineEvent, filters: TimelineFilters): boolean {
    if (filters.author === "me" && event.mine !== true) {
        return false;
    }

    if (filters.author === "others" && event.mine === true) {
        return false;
    }

    if (filters.needsMe && !event.needsMe) {
        return false;
    }

    return !filters.kinds?.length || filters.kinds.includes(event.kind);
}

function bounded(name: string, events: TimelineEvent[], limit: number, filters: TimelineFilters): SourceEvents {
    const sorted = events.sort((a, b) => b.at.localeCompare(a.at));
    const read = sorted.slice(0, limit);
    return {
        name,
        events: read.filter((event) => keepsEvent(event, filters)),
        truncated: sorted.length > limit,
        oldestAt: read.at(-1)?.at ?? null,
    };
}

/** How much of a session file's tail `lastBranch` reads: a small read first, one larger one when a huge line hid every branch. */
const BRANCH_TAIL_BYTES = [64 * 1024, 1024 * 1024];

/** The last non-empty `gitBranch` (Claude) or `git_branch` (Grok) a transcript's text records, or null. */
export function lastRecordedBranch(text: string): string | null {
    let branch: string | null = null;

    for (const match of text.matchAll(/"(?:gitBranch|git_branch)"\s*:\s*"([^"\\]*)"/g)) {
        if (match[1]) {
            branch = match[1];
        }
    }

    return branch;
}

function sessionEvents(rows: readonly AgentSessionRow[], window: TimelineWindow, deps: TimelineDeps): TimelineEvent[] {
    const events: TimelineEvent[] = [];

    for (const row of rows) {
        const base = {
            project: row.project,
            repo: null,
            sessionId: row.sessionId,
            provider: row.provider,
            cwd: row.cwd,
            mine: true,
            ...(row.gitBranch ? { branch: row.gitBranch } : {}),
        };
        const title = cleanSessionTitle(row.title) ?? row.sessionId.slice(0, 8);
        const born = deps.birth(row.filePath);

        if (born !== null && inWindow(born, window)) {
            events.push({
                ...base,
                id: `start:${row.sessionId}`,
                kind: "session.start",
                at: iso(born),
                title,
                detail: "started",
            });
        }

        if (inWindow(row.mtime, window)) {
            // The row's branch is the first one the session recorded; a later turn may run on another.
            const branch = deps.lastBranch(row.filePath) ?? row.gitBranch;
            events.push({
                ...base,
                ...(branch ? { branch } : {}),
                id: `turn:${row.sessionId}`,
                kind: "session.turn",
                at: iso(row.mtime),
                title,
                detail: "last turn",
            });
        }
    }

    return events;
}

function prRef(pr: HubPr): TimelinePrRef {
    const project = pr.origin.web ? new URL(pr.origin.web).pathname.replace(/^\/+|\/+$/g, "") : pr.repo;
    const mark = pr.origin.kind === "gitlab" ? "!" : "#";
    return { ref: `${project || pr.repo}${mark}${pr.number}`, number: pr.number, url: pr.url };
}

function prEvents(prs: readonly HubPr[], window: TimelineWindow): TimelineEvent[] {
    const events: TimelineEvent[] = [];

    for (const pr of prs) {
        const ref = prRef(pr);
        const base = {
            project: pr.repo,
            repo: pr.repoRoot,
            pr: ref,
            url: pr.url,
            branch: pr.headBranch,
            state: pr.state,
            ci: pr.ci,
            ...(pr.author ? { author: pr.author } : {}),
            ...(pr.isMine !== null ? { mine: pr.isMine } : {}),
        };
        const created = Date.parse(pr.createdAt);
        const updated = Date.parse(pr.updatedAt);

        if (inWindow(created, window)) {
            events.push({
                ...base,
                id: `pr-open:${ref.ref}`,
                kind: "pr",
                at: iso(created),
                title: pr.title,
                detail: `opened ${ref.ref}`,
            });
        }

        if (inWindow(updated, window) && updated !== created) {
            // The list has no merge time; a merged PR's last update is its merge, near enough for a day view.
            const what = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "updated";
            events.push({
                ...base,
                id: `pr-${what}:${ref.ref}`,
                kind: "pr",
                at: iso(updated),
                title: pr.title,
                detail: `${what} ${ref.ref}`,
            });
        }
    }

    return events;
}

/**
 * One line for a review comment: its first bold line when it has one near the top (review bots put
 * a badge line first and the finding in bold under it), else its first line of text.
 */
export function commentTitle(markdown: string): string {
    const lines = markdown
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const bold = lines.slice(0, 8).find((line) => /^\*\*[^*].*\*\*$/.test(line));
    const text = (bold ?? lines[0] ?? "").replace(/[*_`#>]/g, "").trim();
    return text.slice(0, 160) || "(no text)";
}

function threadEvents(results: readonly ThreadsResult[], window: TimelineWindow): TimelineEvent[] {
    const events: TimelineEvent[] = [];

    for (const result of results) {
        const { pr, viewer } = result;
        const mark = pr.provider === "gitlab" ? "!" : "#";
        const ref: TimelinePrRef = {
            ref: `${pr.project}${mark}${pr.number}`,
            number: pr.number,
            url: pr.webUrl || pr.url,
        };
        const prIsMine = viewer !== null && pr.author === viewer;

        for (const thread of result.threads) {
            const last = thread.comments.at(-1);
            const lastByOther = last !== undefined && (viewer === null || last.author.username !== viewer);

            for (const comment of thread.comments) {
                const at = Date.parse(comment.createdAt);

                if (!inWindow(at, window) || comment.isDraft) {
                    continue;
                }

                const mine = viewer !== null && comment.author.username === viewer;
                events.push({
                    id: `thread:${comment.id}`,
                    kind: "thread",
                    at: iso(at),
                    title: commentTitle(comment.bodyMarkdown),
                    detail: `${thread.path}:${thread.line} · ${ref.ref}`,
                    project: pr.project.split("/").pop() ?? pr.project,
                    repo: pr.repoPath,
                    author: comment.author.username || comment.author.name,
                    pr: ref,
                    url: ref.url,
                    mine,
                    threadId: thread.id,
                    path: thread.path,
                    line: thread.line,
                    state: thread.resolved ? "resolved" : "open",
                    ...(comment === last && prIsMine && !thread.resolved && lastByOther ? { needsMe: true } : {}),
                    ...(pr.sourceBranch ? { branch: pr.sourceBranch } : {}),
                });
            }
        }
    }

    return events;
}

const OPEN_DECISION_STATES = new Set(["open", "drafted"]);
const ANSWERED_DECISION_STATES = new Set(["answered", "sent", "acknowledged", "implemented"]);

function decisionEvents(rows: readonly DecisionRecord[], window: TimelineWindow): TimelineEvent[] {
    const events: TimelineEvent[] = [];

    for (const row of rows) {
        if (row.type === "todo") {
            continue;
        }

        const open = OPEN_DECISION_STATES.has(row.state);
        const answered = ANSWERED_DECISION_STATES.has(row.state);

        if (!open && !answered) {
            continue;
        }

        const at = Date.parse((open ? row.createdTs : undefined) ?? row.updatedTs);

        if (!inWindow(at, window)) {
            continue;
        }

        const answer = row.option
            ? `${row.option})${row.answer ? ` ${cut(row.answer, 80)}` : ""}`
            : cut(row.answer ?? "", 80);
        events.push({
            id: `decision:${row.id}`,
            kind: "decision",
            at: iso(at),
            title: row.title ?? cut(row.prompt, 160),
            detail: open ? `#${row.number} waiting` : `#${row.number} ${row.state}${answer ? `: ${answer}` : ""}`,
            project: row.project ?? (row.cwd ? basename(row.cwd) : null),
            repo: row.repoRoot ?? null,
            sessionId: row.sessionId,
            mine: true,
            state: row.state,
            ...(row.provider ? { provider: row.provider } : {}),
            ...(row.cwd ? { cwd: row.cwd } : {}),
            ...(row.branch ? { branch: row.branch } : {}),
            ...(open ? { needsMe: true } : {}),
        });
    }

    return events;
}

function ciEvents(
    items: readonly TimelineNotifyItem[],
    prs: readonly HubPr[],
    window: TimelineWindow
): TimelineEvent[] {
    const events: TimelineEvent[] = [];
    const byUrl = new Map(prs.map((pr) => [pr.url, pr]));

    for (const item of items) {
        if (item.type !== "ciFailed" && item.type !== "ciPassed") {
            continue;
        }

        const at = Date.parse(item.at);

        if (!inWindow(at, window)) {
            continue;
        }

        const pr = byUrl.get(item.url);
        const mark = item.provider === "gitlab" ? "!" : "#";
        const ref: TimelinePrRef = { ref: `${item.project}${mark}${item.number}`, number: item.number, url: item.url };
        const failed = item.type === "ciFailed";
        const mine = pr?.isMine ?? null;
        events.push({
            id: `ci:${item.key}:${item.at}`,
            kind: "ci",
            at: iso(at),
            title: item.title,
            detail: `CI ${failed ? "failed" : "passed"} · ${ref.ref}`,
            project: pr?.repo ?? item.project.split("/").pop() ?? item.project,
            repo: pr?.repoRoot ?? null,
            pr: ref,
            url: item.url,
            state: failed ? "failed" : "success",
            ...(pr?.headBranch ? { branch: pr.headBranch } : {}),
            ...(pr?.author ? { author: pr.author } : {}),
            ...(mine !== null ? { mine } : {}),
            ...(failed && mine ? { needsMe: true } : {}),
        });
    }

    return events;
}

/** A commit as git read it, with the row made of it. */
interface CommitRow {
    commit: CommitInfo;
    event: TimelineEvent;
}

/** Cherry-pick and rebase keep the author, the author time and the subject; a conflict changes only the patch. */
function changeKey(commit: CommitInfo): string {
    return `${commit.author.email.toLowerCase()}\0${commit.author.epoch}\0${commit.subject}`;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
    const counts = new Map<string, number>();

    for (const item of items) {
        const found = key(item);
        counts.set(found, (counts.get(found) ?? 0) + 1);
    }

    return counts;
}

function authoredKey(commit: CommitInfo): string {
    return `${commit.author.email.toLowerCase()}\0${commit.author.epoch}`;
}

/**
 * The commits of a page that may be copies of one another: they share a subject, or an author and author
 * time (a pick reworded on the way keeps those). Only these get a patch-id, so a page with neither repeated
 * costs no extra git run.
 */
export function copyCandidates(commits: readonly CommitInfo[]): string[] {
    const bySubject = countBy(commits, (commit) => commit.subject);
    const byAuthored = countBy(commits, authoredKey);
    return commits
        .filter((commit) => (bySubject.get(commit.subject) ?? 0) > 1 || (byAuthored.get(authoredKey(commit)) ?? 0) > 1)
        .map((commit) => commit.sha);
}

/** `refs/heads/feat/x` → `feat/x`, `refs/remotes/origin/x` → `origin/x`, a tag → its name; HEAD or nothing → null. */
export function branchOfRef(ref: string | undefined): string | null {
    if (!ref || ref === "HEAD") {
        return null;
    }

    return ref.replace(/^refs\/(heads|remotes|tags)\//, "");
}

/** "also on polish/hub-ui", "also on a, b", "also on a, b +2"; a copy no branch reaches shows its sha. */
function alsoOnLabel(copies: readonly TimelineCopy[]): string {
    const names = [...new Set(copies.map((copy) => copy.branch ?? short(copy.sha)))];
    const shown = names.slice(0, 2).join(", ");
    return `also on ${shown}${names.length > 2 ? ` +${names.length - 2}` : ""}`;
}

/**
 * One row per change, not one per branch it landed on (2026-10-10: every cherry-picked commit of the campaign
 * showed twice or three times). Commits are copies when their patch-ids are equal, or when they share the
 * author, author time and subject: cherry-pick and rebase keep those, and a conflict resolved on the way
 * changes the patch (the fix(hub) commit picked onto feat/agents-comms-polish differs in one file).
 *
 * The row that stays is the copy the checked-out branch holds, the newest of them; with none there, the newest
 * copy, the latest landing. It lists the others in `alsoOn` and its detail. Two copies on the checked-out
 * branch (a change applied twice on one history) both stay. Newest first in, newest first out.
 */
export function foldCopies(rows: readonly CommitRow[], facts: CommitCopyFacts): TimelineEvent[] {
    const parent = new Map<string, string>();
    const find = (sha: string): string => {
        let root = sha;

        while (parent.get(root) !== root) {
            root = parent.get(root) ?? root;
        }

        parent.set(sha, root);
        return root;
    };
    const firstByKey = new Map<string, string>();
    const join = (key: string, sha: string) => {
        const first = firstByKey.get(key);

        if (first === undefined) {
            firstByKey.set(key, sha);
        } else {
            parent.set(find(sha), find(first));
        }
    };

    for (const { commit } of rows) {
        parent.set(commit.sha, commit.sha);
    }

    for (const { commit } of rows) {
        join(`change\0${changeKey(commit)}`, commit.sha);
        const patchId = facts.patchIds.get(commit.sha);

        if (patchId) {
            join(`patch\0${patchId}`, commit.sha);
        }
    }

    const groups = new Map<string, CommitRow[]>();

    for (const row of rows) {
        const root = find(row.commit.sha);
        groups.set(root, [...(groups.get(root) ?? []), row]);
    }

    const dropped = new Set<string>();

    for (const copies of groups.values()) {
        if (copies.length < 2) {
            continue;
        }

        const newest = [...copies].sort((a, b) => b.commit.committer.epoch - a.commit.committer.epoch);
        const keep = newest.find((row) => facts.onHead.has(row.commit.sha)) ?? newest[0];
        const folded = newest.filter((row) => row !== keep && !facts.onHead.has(row.commit.sha));

        if (folded.length === 0) {
            continue;
        }

        keep.event.alsoOn = folded.map((row) => ({ sha: row.commit.sha, branch: branchOfRef(row.commit.source) }));
        keep.event.detail = `${short(keep.commit.sha)} · ${alsoOnLabel(keep.event.alsoOn)}`;

        for (const row of folded) {
            dropped.add(row.commit.sha);
        }
    }

    return rows.filter((row) => !dropped.has(row.commit.sha)).map((row) => row.event);
}

/** A sha's patch-id never changes; the file only ages out when no page wrote it for a year. */
const PATCH_ID_TTL = "365 days";

/** Patch-ids never change for a sha: the hub keeps them in one file, bounded to the newest `limit` entries. */
export async function cachedPatchIds({
    repo,
    shas,
    storage,
    compute,
    limit = 5_000,
}: {
    /** One file per repository (its common dir): four repositories read at once never write one file. */
    repo: string;
    shas: readonly string[];
    storage: Storage;
    compute: (missing: string[]) => Promise<Map<string, string>>;
    limit?: number;
}): Promise<{ patchIds: Map<string, string>; computed: number }> {
    const key = `timeline/patch-ids-${createHash("sha1").update(repo).digest("hex").slice(0, 12)}.json`;
    const known = (await storage.getCacheFile<Record<string, string>>(key, PATCH_ID_TTL)) ?? {};
    const missing = shas.filter((sha) => !(sha in known));

    if (missing.length > 0) {
        const found = await compute(missing);

        // A sha with no patch (a merge, an empty commit) is kept as "", so it is not asked again.
        for (const sha of missing) {
            known[sha] = found.get(sha) ?? "";
        }

        const entries = Object.entries(known);
        await storage.putCacheFile(
            key,
            Object.fromEntries(entries.slice(Math.max(0, entries.length - limit))),
            PATCH_ID_TTL
        );
    }

    const patchIds = new Map<string, string>();

    for (const sha of shas) {
        if (known[sha]) {
            patchIds.set(sha, known[sha]);
        }
    }

    return { patchIds, computed: missing.length };
}

/** `git diff-tree --stdin -p | git patch-id --stable` over `shas` (full ids), in one pipeline. */
export async function patchIdsOf(cwd: string, shas: readonly string[]): Promise<Map<string, string>> {
    const diff = Bun.spawn(["git", "diff-tree", "--stdin", "-p", "--no-color"], {
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
    });
    diff.stdin.write(`${shas.join("\n")}\n`);
    diff.stdin.end();
    const patch = Bun.spawn(["git", "patch-id", "--stable"], {
        cwd,
        stdin: diff.stdout,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
    });
    const [out, diffCode, patchCode] = await Promise.all([
        new Response(patch.stdout).text(),
        diff.exited,
        patch.exited,
    ]);

    if (diffCode !== 0 || patchCode !== 0) {
        const stderr = (await new Response(diff.stderr).text()) + (await new Response(patch.stderr).text());
        throw new Error(`git patch-id exited ${diffCode}/${patchCode}: ${stderr.trim().slice(0, 200)}`);
    }

    const found = new Map<string, string>();

    for (const line of out.split("\n")) {
        const [patchId, sha] = line.trim().split(" ");

        if (patchId && sha) {
            found.set(sha, patchId);
        }
    }

    return found;
}

async function repoEvents(
    repo: RepoRef,
    window: TimelineWindow,
    limit: number,
    filters: TimelineFilters,
    deps: TimelineDeps
): Promise<SourceEvents[]> {
    const project = basename(repo.root);
    const { log: text, email } = await prof.measureAsync(`repo.commits ${project}`, () =>
        deps.commits(repo, window, limit, filters.author ?? "all")
    );
    const me = email.trim().toLowerCase();
    const read: CommitRow[] = [];

    for (const commit of parseLogZ(text, { withSource: true })) {
        if (!inWindow(commit.committer.epoch * 1000, window)) {
            continue;
        }

        read.push({
            commit,
            event: {
                id: `commit:${commit.sha}`,
                kind: "commit",
                at: iso(commit.committer.epoch * 1000),
                title: commit.subject,
                detail: short(commit.sha),
                project,
                repo: repo.root,
                sha: commit.sha,
                author: commit.author.name,
                ...(me ? { mine: commit.author.email.toLowerCase() === me } : {}),
            },
        });
    }

    const candidates = copyCandidates(read.map((row) => row.commit));
    // The checked-out branch is read only across the candidates' own times, not the whole range.
    const times = read.filter((row) => candidates.includes(row.commit.sha)).map((row) => row.commit.committer.epoch);
    const span: TimelineWindow = {
        since: new Date(Math.min(...times) * 1000),
        upper: new Date((Math.max(...times) + 1) * 1000),
    };
    const commits =
        candidates.length === 0
            ? read.map((row) => row.event)
            : await prof.measureAsync(`fold ${project} ${candidates.length} candidates`, async () =>
                  foldCopies(read, await deps.commitCopies(repo, candidates, span))
              );

    const pushes: TimelineEvent[] = [];

    for (const { branch, lines } of deps.remoteLogs(repo)) {
        for (const push of parsePushes(lines, window.since, window.upper)) {
            pushes.push({
                id: `push:${branch}:${push.to}:${push.at}`,
                kind: "push",
                at: iso(push.at),
                title: `Pushed ${branch}`,
                detail: /^0+$/.test(push.from)
                    ? `new branch at ${short(push.to)}`
                    : `${short(push.from)}..${short(push.to)}`,
                project,
                repo: repo.root,
                sha: push.to,
                fromSha: push.from,
                branch,
                mine: true,
            });
        }
    }

    // git already cut the log at `limit`: a full page of commits means older ones exist in the window. Both
    // follow what git read, before the fold: the page ends where the read stopped.
    commits.sort((a, b) => b.at.localeCompare(a.at));
    const oldestRead = read.map((row) => row.event.at).sort()[0] ?? null;
    return [
        {
            name: `${project} commits`,
            events: commits.filter((event) => keepsEvent(event, filters)),
            truncated: read.length >= limit,
            oldestAt: oldestRead,
        },
        bounded(`${project} pushes`, pushes, limit, filters),
    ];
}

/**
 * Cuts the merged feed into one page. A source that hit its limit is incomplete below its oldest
 * event, so the page ends there (or at `limit`), and the caller reads the rest with `nextBefore`.
 */
export function pageEvents(
    sources: readonly SourceEvents[],
    limit: number
): { events: TimelineEvent[]; hasMore: boolean; nextBefore: string | null; truncated: string[] } {
    const merged = [
        ...new Map(sources.flatMap((source) => source.events).map((event) => [event.id, event])).values(),
    ].sort((a, b) => b.at.localeCompare(a.at));
    const truncated = sources.filter((source) => source.truncated && source.oldestAt !== null);
    const floor =
        truncated
            .map((source) => source.oldestAt ?? "")
            .sort()
            .at(-1) ?? null;
    const complete = floor === null ? merged : merged.filter((event) => event.at >= floor);
    const events = complete.slice(0, limit);
    const hasMore = events.length < merged.length || truncated.length > 0;
    // With no event left on the page (the filters dropped every read event), the cursor is the
    // floor itself, so the next page starts where this one's sources stopped reading.
    const nextBefore = !hasMore ? null : (events.at(-1)?.at ?? floor);
    return {
        events,
        hasMore,
        nextBefore,
        truncated: truncated.map((source) => source.name),
    };
}

/** Builds one page from the deps; `buildTimeline` adds the caches. Newest first. */
export async function collectTimeline({
    since,
    until,
    before = null,
    limit = TIMELINE_LIMITS.pageDefault,
    filters = {},
    now = new Date(),
    prs = true,
    prsMaxCacheAgeSeconds,
    deps,
}: {
    since: Date;
    until?: Date;
    before?: Date | null;
    limit?: number;
    filters?: TimelineFilters;
    now?: Date;
    prs?: boolean;
    prsMaxCacheAgeSeconds?: number;
    deps: TimelineDeps;
}): Promise<Omit<TimelineResult, "elapsedMs" | "cached">> {
    const end = until ?? now;
    const window: TimelineWindow = { since, upper: before && before < end ? before : end };
    const warnings: string[] = [];
    const hours = Math.max(1, Math.ceil((now.getTime() - since.getTime()) / 3_600_000));
    const rows = (await deps.sessions(hours)).filter((row) => !row.archived && row.mtime >= since.getTime());
    const sources: SourceEvents[] = [bounded("sessions", sessionEvents(rows, window, deps), limit, filters)];

    const cwds = [...new Set(rows.map((row) => row.cwd).filter((cwd) => cwd && existsSync(cwd)))];
    const repos = new Map<string, RepoRef>();
    const repoByCwd = new Map<string, RepoRef>();

    for (const cwd of cwds) {
        const repo = await deps.repoOf(cwd);

        if (!repo) {
            continue;
        }

        repoByCwd.set(cwd, repo);

        if (!repos.has(repo.commonDir)) {
            repos.set(repo.commonDir, repo);
        }
    }

    const list = [...repos.values()].slice(0, TIMELINE_LIMITS.repos);

    if (repos.size > list.length) {
        warnings.push(`only the first ${list.length} of ${repos.size} repositories were read`);
    }

    const perRepo = await concurrentMap({
        items: list,
        concurrency: 4,
        fn: (repo) => repoEvents(repo, window, limit, filters, deps),
        onError: (repo, error) => {
            warnings.push(`${basename(repo.root)}: ${error instanceof Error ? error.message : String(error)}`);
            log.warn({ error, repo: repo.root }, "timeline: could not read a repository");
        },
    });

    for (const found of perRepo.values()) {
        sources.push(...found);
    }

    const roots = list.map((repo) => repo.root);

    // A session's events name its repository (a worktree folder counts under the repository it
    // belongs to), so the project filter groups them and a click can open it.
    for (const event of sources[0].events) {
        if (event.sessionId && !event.repo) {
            const repo = repoByCwd.get(event.cwd ?? "");

            if (repo) {
                event.repo = repo.root;
                event.project = basename(repo.root);
            }
        }
    }

    let prList: HubPr[] = [];

    if (prs && roots.length > 0) {
        try {
            const perProject = prRangeLimit(since, now);
            prList = await deps.prs(roots, since, perProject, prsMaxCacheAgeSeconds);
            sources.push(bounded("PR events", prEvents(prList, window), limit, filters));

            for (const repo of fullPrLists(prList, perProject)) {
                warnings.push(
                    `PR events: ${repo} has more than ${perProject} PRs updated in this range; the least recently updated are missing`
                );
            }
        } catch (error) {
            warnings.push(`PRs: ${error instanceof Error ? error.message : String(error)}`);
            log.warn({ error }, "timeline: the PR list failed");
        }
    }

    // A push updates the PR whose head is its branch: the row can open it without a lookup.
    const prByBranch = new Map(prList.map((pr) => [`${pr.repoRoot ?? ""}\0${pr.headBranch}`, pr]));

    for (const source of sources) {
        for (const event of source.events) {
            const pr = event.kind === "push" ? prByBranch.get(`${event.repo ?? ""}\0${event.branch ?? ""}`) : undefined;

            if (pr) {
                event.pr = prRef(pr);
                event.url = pr.url;
            }
        }
    }

    sources.push(bounded("review comments", threadEvents(deps.threads(), window), limit, filters));
    sources.push(bounded("decisions", decisionEvents(deps.decisions(), window), limit, filters));
    sources.push(bounded("CI results", ciEvents(deps.notifyItems(), prList, window), limit, filters));

    const page = pageEvents(sources, limit);

    // A cursor that does not move (a whole page of events at one instant) would page forever: step
    // past that instant, at the price of any further event stamped exactly on it.
    if (before && page.nextBefore && Date.parse(page.nextBefore) >= before.getTime()) {
        page.nextBefore = iso(before.getTime() - 1);
    }

    const counts = Object.fromEntries(TIMELINE_KINDS.map((kind) => [kind, 0])) as Record<TimelineKind, number>;

    for (const event of page.events) {
        counts[event.kind]++;
    }

    return {
        since: since.toISOString(),
        until: end.toISOString(),
        before: before ? before.toISOString() : null,
        limit,
        events: page.events,
        repos: roots,
        counts,
        warnings,
        hasMore: page.hasMore,
        nextBefore: page.nextBefore,
        truncated: page.truncated,
    };
}

// MARK: - Real sources

/**
 * The window's commits on every branch and remote: `--all` without `refs/stash`, whose "WIP on …" and
 * "index on …" commits are a stash's bookkeeping, not work (a `git stash` showed as two commits, 2026-10-10).
 */
export function timelineLogArgs({
    window,
    limit,
    author,
    email,
}: {
    window: TimelineWindow;
    limit: number;
    author: TimelineAuthor;
    email: string;
}): string[] {
    const args = [
        "log",
        "-z",
        // `%S`: the ref each commit was reached by, the branch a folded copy names ("also on …").
        LOG_FORMAT_WITH_SOURCE,
        // Before `--all`: an exclusion applies to the next `--all`, `--branches` or `--glob` only.
        "--exclude=refs/stash",
        "--all",
        `--since=${window.since.toISOString()}`,
        `--until=${window.upper.toISOString()}`,
        `-${limit}`,
    ];

    // "others" cannot be asked of git without PCRE, so it is filtered after the read.
    if (author === "me" && email) {
        args.push(`--author=${email}`);
    }

    return args;
}

export async function git(args: string[], cwd: string, runner: CommandRunner = spawnRunner): Promise<string> {
    const result = await runner(["git", ...args], { cwd, timeoutMs: 15_000 });

    if (result.code !== 0) {
        throw new Error(`git ${args[0]} exited ${result.code}: ${result.stderr.trim().slice(0, 200)}`);
    }

    return result.stdout;
}

function walkLogs(dir: string, prefix: string, out: Array<{ branch: string; lines: string[] }>): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
            walkLogs(path, prefix, out);
            continue;
        }

        const name = relative(prefix, path);
        // `origin/feat/x`: the remote name is the first segment, the rest is the branch.
        const branch = name.split("/").slice(1).join("/");

        if (branch && branch !== "HEAD") {
            out.push({ branch, lines: readFileSync(path, "utf8").split("\n") });
        }
    }
}

export function hubStorage(): Storage {
    return new Storage("hub");
}

/** The hub's cached thread lists (`tools hub pr threads`), one file per PR; no network. */
export function cachedThreads(): ThreadsResult[] {
    const dir = join(hubStorage().getCacheDir(), "pr-threads");

    if (!existsSync(dir)) {
        return [];
    }

    const results: ThreadsResult[] = [];

    for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) {
            continue;
        }

        try {
            results.push(SafeJSON.parse(readFileSync(join(dir, name), "utf8"), { strict: true }) as ThreadsResult);
        } catch (error) {
            log.debug({ error, name }, "timeline: unreadable thread cache");
        }
    }

    return results;
}

/** The projects whose PR list came back full: the host had more PRs than `limit` for the range. */
export function fullPrLists(prs: readonly HubPr[], limit: number): string[] {
    const counts = new Map<string, number>();

    for (const pr of prs) {
        counts.set(pr.repo, (counts.get(pr.repo) ?? 0) + 1);
    }

    return [...counts].filter(([, count]) => count >= limit).map(([repo]) => repo);
}

/** A range's start to its hour: rolling ranges move on every call, and one fetch serves the hour. */
export function prListSince(since: Date): Date {
    const hour = new Date(since);
    hour.setMinutes(0, 0, 0);
    return hour;
}

/**
 * PRs asked per project for a range: a day's page for a range of about a day, the larger bound for
 * longer ones. Measured 2026-09-25 on GitHub: a page of 100 took 5.5 to 7.4 s, a page of 30 about 2 s.
 */
export function prRangeLimit(since: Date, now = new Date()): number {
    return now.getTime() - since.getTime() <= 26 * 3_600_000
        ? TIMELINE_LIMITS.prsPerProject
        : TIMELINE_LIMITS.prsInRange;
}

/** How old a PR list the feed uses at most: it is the feed's one network call. */
const PRS_MAX_AGE_SECONDS = 5 * 60;

/**
 * The PR list of these projects, from a cache at most `maxCacheAgeSeconds` old and never past five
 * minutes (the one network call of the feed). With `since`, the host is asked for the PRs updated
 * since that hour, at most `limit` per project; without it, the newest `prsPerProject` (a branch's
 * PR lookup in a row's detail).
 */
export async function cachedPrs(
    roots: string[],
    since?: Date,
    limit: number = TIMELINE_LIMITS.prsPerProject,
    maxCacheAgeSeconds?: number
): Promise<HubPr[]> {
    const updatedSince = since ? prListSince(since) : undefined;
    const rootsKey = createHash("sha1").update(roots.join("\n")).digest("hex").slice(0, 12);
    // `prs2`: the entry is `{ prs, complete }` now; an older `prs-` file holds a bare array.
    const key = `timeline/prs2-${rootsKey}${updatedSince ? `-since-${updatedSince.getTime()}-${limit}` : ""}.json`;
    const { value } = await cached({
        storage: hubStorage(),
        key,
        maxAgeSeconds: capMaxCacheAge(maxCacheAgeSeconds, PRS_MAX_AGE_SECONDS),
        fetch: () => fetchPrs({ roots, updatedSince, limit }),
        // A project whose lookup failed has unknown PRs, not none: a later read asks the forge again.
        shouldStore: (result) => result.complete,
    });
    return value.prs;
}

async function fetchPrs({
    roots,
    updatedSince,
    limit,
}: {
    roots: string[];
    updatedSince?: Date;
    limit: number;
}): Promise<{ prs: HubPr[]; complete: boolean }> {
    const { prs, repos } = await hubPrs({
        paths: roots,
        state: "all",
        limit,
        ...(updatedSince ? { updatedSince } : {}),
    });

    for (const repo of repos.filter((entry) => entry.error)) {
        log.warn({ repo: repo.repo, error: repo.error, updatedSince }, "timeline: a project's PR list failed");
    }

    log.debug({ projects: repos.length, prs: prs.length, updatedSince }, "timeline: PR list fetched");
    return { prs, complete: repos.every((entry) => !entry.error) };
}

export const realTimelineDeps: TimelineDeps = {
    sessions: (hours) => listAgentSessionRows({ hours, withUsage: false, maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS }),
    birth: (path) => {
        try {
            const info = statSync(path);
            return info.birthtimeMs > 0 ? info.birthtimeMs : null;
        } catch (error) {
            log.debug({ error, path }, "timeline: session file is gone");
            return null;
        }
    },
    lastBranch: (path) => {
        try {
            const size = statSync(path).size;
            const fd = openSync(path, "r");

            try {
                for (const bytes of BRANCH_TAIL_BYTES) {
                    const length = Math.min(bytes, size);
                    const buffer = Buffer.alloc(length);
                    const read = readSync(fd, buffer, 0, length, size - length);
                    const branch = lastRecordedBranch(buffer.subarray(0, read).toString("utf8"));

                    if (branch || length === size) {
                        return branch;
                    }
                }

                return null;
            } finally {
                closeSync(fd);
            }
        } catch (error) {
            log.debug({ error, path }, "timeline: could not read the session's last branch");
            return null;
        }
    },
    repoOf: async (cwd) => {
        try {
            const out = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
            const commonDir = out.trim();

            if (!commonDir) {
                return null;
            }

            const root = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
            return { root, commonDir };
        } catch (error) {
            log.debug({ error, cwd }, "timeline: not a git folder");
            return null;
        }
    },
    commits: async (repo, window, limit, author) => {
        const email = (await git(["config", "user.email"], repo.root).catch(() => "")).trim();
        return { log: await git(timelineLogArgs({ window, limit, author, email }), repo.root), email };
    },
    commitCopies: async (repo, shas, window) => {
        const { patchIds, computed } = await cachedPatchIds({
            repo: repo.commonDir,
            shas,
            storage: hubStorage(),
            compute: (missing) =>
                prof.measureAsync(`fold.patch-ids ${basename(repo.root)} ${missing.length}`, () =>
                    patchIdsOf(repo.root, missing)
                ),
        });
        // The main checkout's branch in the window: the copy it holds is the row that stays.
        const onHead = await prof.measureAsync(`fold.head ${basename(repo.root)}`, () =>
            git(
                ["rev-list", `--since=${window.since.toISOString()}`, `--until=${window.upper.toISOString()}`, "HEAD"],
                repo.root
            ).catch((error) => {
                log.debug({ error, repo: repo.root }, "timeline: no HEAD to prefer copies on");
                return "";
            })
        );
        const wanted = new Set(shas);
        log.debug({ repo: repo.root, candidates: shas.length, computed }, "timeline: commit copies");
        return {
            patchIds,
            onHead: new Set(onHead.split("\n").filter((sha) => wanted.has(sha))),
        };
    },
    remoteLogs: (repo) => {
        const dir = join(repo.commonDir, "logs", "refs", "remotes");
        const found: Array<{ branch: string; lines: string[] }> = [];

        if (existsSync(dir)) {
            walkLogs(dir, dir, found);
        }

        return found;
    },
    prs: cachedPrs,
    threads: cachedThreads,
    decisions: () => readDecisions(decisionFiles().file),
    notifyItems: () => readNotifyState().recent,
};

/**
 * `tools hub timeline`: one page of the feed, served from a cache at most `maxCacheAgeSeconds` old, and
 * never past one minute for the live page (no cursor, the range ends now) or ten minutes for an older
 * page, whose events do not move. Unset keeps those limits; 0 builds it fresh. The PR list inside it
 * follows the same age, capped at its own five minutes, since it is the network call.
 */
export async function buildTimeline({
    since = startOfDay(),
    until,
    before = null,
    limit = TIMELINE_LIMITS.pageDefault,
    filters = {},
    prs = true,
    maxCacheAgeSeconds,
    deps = realTimelineDeps,
    storage = hubStorage(),
    now = new Date(),
}: {
    since?: Date;
    until?: Date;
    before?: Date | null;
    limit?: number;
    filters?: TimelineFilters;
    prs?: boolean;
    maxCacheAgeSeconds?: number;
    deps?: TimelineDeps;
    storage?: Storage;
    now?: Date;
} = {}): Promise<TimelineResult> {
    const started = performance.now();
    const size = Math.min(TIMELINE_LIMITS.pageMax, Math.max(1, Math.floor(limit)));
    const end = until ?? now;
    const upper = before && before < end ? before : end;
    // The caller sets `--until` to its own clock and then starts this process: under load Bun's startup alone
    // took more than a second, the page read as an old one keyed by its exact end, never hit, and left one cache
    // file per call (272 in the hub's cache folder, 2026-10-10).
    const live = upper.getTime() >= now.getTime() - TIMELINE_LIVE_SLACK_MS;
    const shape = [
        filters.author ?? "all",
        filters.needsMe ? "needs-me" : "",
        [...(filters.kinds ?? [])].sort().join(","),
    ].join("|");
    // A live page ends "now", which moves on every call: keyed by its end time it never hit. A rolling
    // range (`24h`, `hour`) moves its start on every call too, so the start is keyed by the minute.
    const sinceKey = Math.floor(since.getTime() / 60_000);
    const key = `timeline/feed-${sinceKey}-${live ? "live" : upper.getTime()}-${size}-${prs ? "prs" : "local"}-${createHash("sha1").update(shape).digest("hex").slice(0, 8)}.json`;
    const { value, hit } = await cached<TimelineResult>({
        storage,
        key,
        maxAgeSeconds: capMaxCacheAge(maxCacheAgeSeconds, live ? 60 : 600),
        fetch: async () => ({
            ...(await prof.measureAsync(`collect ${size}`, () =>
                collectTimeline({
                    since,
                    until: end,
                    before,
                    limit: size,
                    filters,
                    now,
                    prs,
                    prsMaxCacheAgeSeconds: maxCacheAgeSeconds,
                    deps,
                })
            )),
            elapsedMs: Math.round(performance.now() - started),
            cached: false,
        }),
    });

    if (hit) {
        return { ...value, cached: true, elapsedMs: Math.round(performance.now() - started) };
    }

    const result = value;
    log.debug(
        {
            since: result.since,
            until: result.until,
            before: result.before,
            events: result.events.length,
            counts: result.counts,
            hasMore: result.hasMore,
            truncated: result.truncated,
            elapsedMs: result.elapsedMs,
        },
        "timeline built"
    );
    return result;
}
