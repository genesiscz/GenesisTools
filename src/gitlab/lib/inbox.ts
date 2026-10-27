/**
 * `gitlab inbox`: what changed on the merge requests you take part in since you last looked. Your own MRs
 * ("reviews you received") and the MRs you review: new comments by others, pushed commits, approvals and merges,
 * a failed pipeline on your MR, and the threads whose last word is someone else's. Pending to-dos ride along.
 *
 * The mark is per MR: the highest note id seen, so a skewed clock cannot hide or repeat a comment. An MR seen for
 * the first time falls back to the check's time.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type GitLabApi, getUserEvents, restGet, restGetPaginated } from "@app/gitlab/lib/client";
import { storage } from "@app/gitlab/lib/config";
import { getDateStyle } from "@app/gitlab/lib/dates";
import { errorMessage } from "@app/gitlab/lib/http";
import { pool } from "@app/gitlab/lib/pool";
import type { Note } from "@app/gitlab/lib/review-render";
import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteFileSync, isJsonObject, isMissingFileError } from "@genesiscz/utils/storage/atomic-file";

export const INBOX_ROLES = ["author", "reviewer", "all"] as const;
export type InboxRole = (typeof INBOX_ROLES)[number];

/** How far back `gitlab inbox` looks for MRs you commented on, when you are not a listed reviewer. */
export const DEFAULT_LOOKBACK_DAYS = 30;
/** The window of the very first check, before any mark exists. */
export const FIRST_CHECK_HOURS = 24;

// ─── state ─────────────────────────────────────────────────────────────────────

/** One check: when it ran, and the highest note id it saw on each MR (`<project id>!<iid>`). */
export interface InboxCheck {
    lastCheckedAt: string;
    mrs: Record<string, number>;
}

/** Every check, keyed by host, user and scope, so a one-project check never moves the all-projects mark. */
export interface InboxState {
    checks: Record<string, InboxCheck>;
}

export function inboxStatePath(dir: string = storage.getBaseDir()): string {
    return join(dir, "inbox.json");
}

export function checkKey(host: string, user: string, scope: string): string {
    return `${host} ${user} ${scope}`;
}

export function mrKey(projectId: number, iid: number): string {
    return `${projectId}!${iid}`;
}

function isCheck(value: unknown): value is InboxCheck {
    return (
        isJsonObject(value) &&
        typeof value.lastCheckedAt === "string" &&
        Number.isFinite(Date.parse(value.lastCheckedAt)) &&
        isJsonObject(value.mrs) &&
        Object.values(value.mrs).every((id) => typeof id === "number" && Number.isSafeInteger(id) && id >= 0)
    );
}

/** The saved checks; a missing file is no check yet. A file that does not parse is an error, never a silent reset. */
export function readInboxState(path: string): InboxState {
    let text: string;

    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if (isMissingFileError(error)) {
            return { checks: {} };
        }

        throw error;
    }

    const raw: unknown = SafeJSON.parse(text);
    if (!isJsonObject(raw) || !isJsonObject(raw.checks)) {
        throw new Error(
            `${path} is not an inbox state file (expected { "checks": { … } }); move it away to start over`
        );
    }

    const checks: Record<string, InboxCheck> = {};
    for (const [key, check] of Object.entries(raw.checks)) {
        if (!isCheck(check)) {
            throw new Error(`${path} has an invalid check ${SafeJSON.stringify(key)}; repair it or move the file away`);
        }
        checks[key] = check;
    }

    return { checks };
}

export function writeInboxState(path: string, state: InboxState): void {
    atomicWriteFileSync(path, `${SafeJSON.stringify(state, null, 2)}\n`);
}

/** The check after a run that read everything: its start time, and every MR's highest note id. */
export function advanceCheck(previous: InboxCheck | undefined, startedAt: string, seen: MrActivity[]): InboxCheck {
    const mrs = { ...(previous?.mrs ?? {}) };

    for (const activity of seen) {
        const key = mrKey(activity.mr.projectId, activity.mr.iid);
        mrs[key] = Math.max(mrs[key] ?? 0, activity.lastNoteId);
    }

    return { lastCheckedAt: startedAt, mrs };
}

// ─── GitLab shapes ─────────────────────────────────────────────────────────────

export interface InboxMr {
    projectId: number;
    iid: number;
    title: string;
    webUrl: string;
    /** `group/name`, read from the MR's link. */
    project: string;
    author: string;
    updatedAt: string;
    state: string;
}

interface RawListMr {
    project_id: number;
    iid: number;
    title: string;
    web_url: string;
    author?: { username?: string };
    updated_at: string;
    state: string;
}

export interface InboxTodo {
    id: number;
    projectId: number | null;
    /** The MR's iid; null for a to-do on an issue, a commit or anything else. */
    iid: number | null;
    action: string;
    author: string;
    title: string;
    url: string;
    createdAt: string;
}

interface RawTodo {
    id: number;
    project?: { id?: number } | null;
    author?: { username?: string };
    action_name: string;
    target_type?: string;
    target?: { iid?: number; title?: string } | null;
    target_url?: string;
    body?: string;
    created_at: string;
}

export interface InboxNote extends Note {
    id: number;
}

export interface InboxDiscussion {
    id?: string;
    individual_note?: boolean;
    notes?: InboxNote[];
}

export interface InboxPipeline {
    status: string;
    web_url?: string;
    updated_at?: string;
    created_at?: string;
}

function projectOfUrl(webUrl: string): string {
    const path = webUrl.replace(/^https?:\/\/[^/]+\//, "");
    const cut = path.indexOf("/-/");

    return cut === -1 ? path : path.slice(0, cut);
}

export function toInboxMr(raw: RawListMr): InboxMr {
    return {
        projectId: raw.project_id,
        iid: raw.iid,
        title: raw.title,
        webUrl: raw.web_url,
        project: projectOfUrl(raw.web_url),
        author: raw.author?.username ?? "",
        updatedAt: raw.updated_at,
        state: raw.state,
    };
}

export function toInboxTodo(raw: RawTodo): InboxTodo {
    const isMr = raw.target_type === "MergeRequest";

    return {
        id: raw.id,
        projectId: raw.project?.id ?? null,
        iid: isMr ? (raw.target?.iid ?? null) : null,
        action: raw.action_name,
        author: raw.author?.username ?? "",
        title: raw.target?.title ?? raw.body ?? "",
        url: raw.target_url ?? "",
        createdAt: raw.created_at,
    };
}

// ─── the analysis of one MR ────────────────────────────────────────────────────

export interface WaitingThread {
    /** The thread's last note, the one to answer. */
    noteId: number;
    url: string;
    lastAuthor: string;
    excerpt: string;
}

export interface MrActivity {
    mr: InboxMr;
    /** `author`: your MR (reviews you received). `reviewer`: an MR you review or commented on. */
    role: "author" | "reviewer";
    /** New comments by other people, per author, most first. */
    comments: Array<{ author: string; count: number }>;
    commits: number;
    approvedBy: string[];
    unapprovedBy: string[];
    merged: boolean;
    closed: boolean;
    /** Your MR's latest pipeline failed since the mark. */
    pipelineFailed: { url: string } | null;
    /** Unresolved threads whose last note is someone else's: on your MR any of them, elsewhere one you wrote in. */
    waiting: WaitingThread[];
    todos: InboxTodo[];
    /** The highest note id on the MR, the next mark. */
    lastNoteId: number;
}

export interface AnalyzeInput {
    mr: InboxMr;
    me: string;
    /** The check's time: decides for an MR that has no note mark yet. */
    since: string;
    /** The MR's note mark; undefined when the MR was never seen. */
    seenNoteId: number | undefined;
    discussions: InboxDiscussion[];
    pipeline: InboxPipeline | null;
    todos: InboxTodo[];
}

const SYSTEM_PATTERNS = {
    commits: /^added (\d+) (?:new )?commits?/i,
    approved: /^approved this merge request/i,
    unapproved: /^unapproved this merge request/i,
    merged: /^merged\b/i,
    closed: /^closed\b/i,
};

function after(iso: string | undefined, since: string): boolean {
    return iso !== undefined && Date.parse(iso) > Date.parse(since);
}

function excerptOf(body: string | undefined): string {
    const line = (body ?? "").replace(/\s+/g, " ").trim();

    return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** What is new on one MR for `me`, and which threads wait for an answer. Pure: the fetch happened before. */
export function analyzeMr(input: AnalyzeInput): MrActivity {
    const { mr, me, since, seenNoteId, discussions } = input;
    const role = mr.author === me ? "author" : "reviewer";
    const notes = discussions.flatMap((d) => d.notes ?? []);
    const isNew = (note: InboxNote): boolean =>
        seenNoteId === undefined ? after(note.created_at, since) : note.id > seenNoteId;
    const fresh = notes.filter((note) => isNew(note) && note.author?.username !== me);

    const perAuthor = new Map<string, number>();
    for (const note of fresh.filter((n) => !n.system)) {
        const author = note.author?.username ?? "?";
        perAuthor.set(author, (perAuthor.get(author) ?? 0) + 1);
    }

    const activity: MrActivity = {
        mr,
        role,
        comments: [...perAuthor].map(([author, count]) => ({ author, count })).sort((a, b) => b.count - a.count),
        commits: 0,
        approvedBy: [],
        unapprovedBy: [],
        merged: false,
        closed: false,
        pipelineFailed: null,
        waiting: [],
        todos: input.todos,
        lastNoteId: notes.reduce((max, note) => Math.max(max, note.id), 0),
    };

    for (const note of fresh.filter((n) => n.system)) {
        const body = note.body ?? "";
        const author = note.author?.username ?? "?";
        const commits = SYSTEM_PATTERNS.commits.exec(body);

        if (commits) {
            activity.commits += Number(commits[1]);
        } else if (SYSTEM_PATTERNS.approved.test(body)) {
            activity.approvedBy.push(author);
        } else if (SYSTEM_PATTERNS.unapproved.test(body)) {
            activity.unapprovedBy.push(author);
        } else if (SYSTEM_PATTERNS.merged.test(body)) {
            activity.merged = true;
        } else if (SYSTEM_PATTERNS.closed.test(body)) {
            activity.closed = true;
        }
    }

    const pipeline = input.pipeline;
    if (
        role === "author" &&
        pipeline?.status === "failed" &&
        after(pipeline.updated_at ?? pipeline.created_at, since)
    ) {
        activity.pipelineFailed = { url: pipeline.web_url ?? mr.webUrl };
    }

    for (const discussion of discussions) {
        const thread = discussion.notes ?? [];
        const resolvable = thread.filter((n) => n.resolvable);

        if (discussion.individual_note || resolvable.length === 0 || resolvable.every((n) => n.resolved)) {
            continue;
        }

        const human = thread.filter((n) => !n.system);
        const last = human.at(-1);
        const tookPart = human.some((n) => n.author?.username === me);

        if (!last || last.author?.username === me || (role === "reviewer" && !tookPart)) {
            continue;
        }

        activity.waiting.push({
            noteId: last.id,
            url: `${mr.webUrl}#note_${last.id}`,
            lastAuthor: last.author?.username ?? "?",
            excerpt: excerptOf(last.body),
        });
    }

    return activity;
}

export function hasNews(activity: MrActivity): boolean {
    return (
        activity.comments.length > 0 ||
        activity.commits > 0 ||
        activity.approvedBy.length > 0 ||
        activity.unapprovedBy.length > 0 ||
        activity.merged ||
        activity.closed ||
        activity.pipelineFailed !== null ||
        activity.waiting.length > 0 ||
        activity.todos.length > 0
    );
}

// ─── the fetch ─────────────────────────────────────────────────────────────────

export interface CollectOptions {
    me: { id: number; username: string };
    since: string;
    role: InboxRole;
    /** One project, or null for every project. */
    projectId: number | null;
    /** Note marks per `mrKey`; empty when `--since` asks for a time. */
    marks: Record<string, number>;
    lookbackDays: number;
    /** Reported per request; the caller prints it. */
    progress?: (message: string) => void;
}

export interface InboxResult {
    /** Every MR read, with or without news; the mark advances over all of them. */
    seen: MrActivity[];
    /** To-dos that are not on a merge request (issues, commits, epics). */
    otherTodos: InboxTodo[];
    /** One line per request that failed. The mark never moves while this is not empty. */
    errors: string[];
}

/** Pending to-dos remain actionable until GitLab marks them done, regardless of when they arrived. */
export function isTodoNews(_todo: InboxTodo, _opts: Pick<CollectOptions, "me" | "since">): boolean {
    return true;
}

function mrListPath(projectId: number | null, filter: string, since?: string): string {
    const query = since
        ? `${filter}&state=all&updated_after=${encodeURIComponent(since)}&order_by=updated_at`
        : `${filter}&state=opened&order_by=updated_at`;

    return projectId === null ? `/merge_requests?scope=all&${query}` : `/projects/${projectId}/merge_requests?${query}`;
}

function shiftIsoDays(iso: string, days: number): string {
    return new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

/** MRs the user commented on in the look-back window, as `[projectId, iid]`. */
async function commentedMrs(api: GitLabApi, opts: CollectOptions): Promise<Array<[number, number]>> {
    // `after` is an exclusive day, so one more day back keeps the first day of the window.
    const events = await getUserEvents(api, opts.me.id, shiftIsoDays(opts.since, -opts.lookbackDays - 1));
    const keys = new Map<string, [number, number]>();

    for (const event of events) {
        const iid = event.note?.noteable_iid;

        if (
            !event.action_name.startsWith("commented") ||
            event.note?.noteable_type !== "MergeRequest" ||
            typeof iid !== "number" ||
            (opts.projectId !== null && event.project_id !== opts.projectId)
        ) {
            continue;
        }

        keys.set(mrKey(event.project_id, iid), [event.project_id, iid]);
    }

    return [...keys.values()];
}

/** Reads the to-dos, the MRs and each MR's discussions. A failed request is recorded, never thrown. */
export async function collectInbox(api: GitLabApi, opts: CollectOptions): Promise<InboxResult> {
    const errors: string[] = [];
    const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
        try {
            return await fn();
        } catch (error) {
            errors.push(`${what}: ${errorMessage(error)}`);
            return null;
        }
    };
    const report = opts.progress ?? (() => undefined);
    const user = encodeURIComponent(opts.me.username);

    report("reading pending to-dos and the merge requests updated since the mark");
    const todoPath = `/todos?state=pending${opts.projectId === null ? "" : `&project_id=${opts.projectId}`}`;
    const [rawTodos, own, reviewed, openOwn, openReviewed] = await Promise.all([
        attempt("to-dos", () => restGetPaginated<RawTodo>(api, todoPath)),
        opts.role === "reviewer"
            ? Promise.resolve([])
            : attempt("your MRs", () =>
                  restGetPaginated<RawListMr>(api, mrListPath(opts.projectId, `author_username=${user}`, opts.since))
              ),
        opts.role === "author"
            ? Promise.resolve([])
            : attempt("MRs you review", () =>
                  restGetPaginated<RawListMr>(api, mrListPath(opts.projectId, `reviewer_username=${user}`, opts.since))
              ),
        opts.role === "reviewer"
            ? Promise.resolve([])
            : attempt("open own MRs", () =>
                  restGetPaginated<RawListMr>(api, mrListPath(opts.projectId, `author_username=${user}`))
              ),
        opts.role === "author"
            ? Promise.resolve([])
            : attempt("open reviewed MRs", () =>
                  restGetPaginated<RawListMr>(api, mrListPath(opts.projectId, `reviewer_username=${user}`))
              ),
    ]);

    const todos = (rawTodos ?? []).map(toInboxTodo).filter((todo) => isTodoNews(todo, opts));
    const mrs = new Map<string, InboxMr>();
    for (const raw of [...(own ?? []), ...(reviewed ?? []), ...(openOwn ?? []), ...(openReviewed ?? [])]) {
        mrs.set(mrKey(raw.project_id, raw.iid), toInboxMr(raw));
    }

    // MRs known only from a to-do or from a comment of yours: read each one, keep those updated since the mark.
    const extra = new Map<string, [number, number]>();
    for (const todo of todos) {
        if (todo.iid !== null && todo.projectId !== null) {
            extra.set(mrKey(todo.projectId, todo.iid), [todo.projectId, todo.iid]);
        }
    }

    if (opts.role !== "author") {
        for (const pair of (await attempt("your comments", () => commentedMrs(api, opts))) ?? []) {
            extra.set(mrKey(...pair), pair);
        }
    }

    const missing = [...extra].filter(([key]) => !mrs.has(key));
    await pool(missing, 4, async ([key, [projectId, iid]]) => {
        const raw = await attempt(`!${iid}`, () =>
            restGet<RawListMr>(api, `/projects/${projectId}/merge_requests/${iid}`)
        );
        const hasTodo = todos.some((t) => t.projectId === projectId && t.iid === iid);

        if (raw && (hasTodo || raw.state === "opened" || after(raw.updated_at, opts.since))) {
            mrs.set(key, toInboxMr(raw));
        }
    });

    const wanted = [...mrs.values()].filter((mr) => {
        const mine = mr.author === opts.me.username;
        return opts.role === "all" || (opts.role === "author" ? mine : !mine);
    });

    report(`reading the discussions of ${wanted.length} merge request(s)`);
    const seen: MrActivity[] = [];
    await pool(wanted, 4, async (mr) => {
        const base = `/projects/${mr.projectId}/merge_requests/${mr.iid}`;
        const discussions = await attempt(`!${mr.iid} discussions`, () =>
            restGetPaginated<InboxDiscussion>(api, `${base}/discussions`)
        );

        if (!discussions) {
            return;
        }

        const ownOpen = mr.author === opts.me.username && mr.state === "opened";
        const pipelines = ownOpen
            ? await attempt(`!${mr.iid} pipelines`, () => restGet<InboxPipeline[]>(api, `${base}/pipelines?per_page=1`))
            : null;

        seen.push(
            analyzeMr({
                mr,
                me: opts.me.username,
                since: opts.since,
                seenNoteId: opts.marks[mrKey(mr.projectId, mr.iid)],
                discussions,
                pipeline: pipelines?.[0] ?? null,
                todos: todos.filter((t) => t.projectId === mr.projectId && t.iid === mr.iid),
            })
        );
    });

    seen.sort((a, b) => Date.parse(b.mr.updatedAt) - Date.parse(a.mr.updatedAt));

    return { seen, otherTodos: todos.filter((t) => t.iid === null), errors };
}

// ─── the report ────────────────────────────────────────────────────────────────

export interface InboxReport {
    host: string;
    user: string;
    /** `project group/name` or `all projects`. */
    scope: string;
    since: string;
    sinceSource: "mark" | "flag" | "first";
    own: MrActivity[];
    reviewing: MrActivity[];
    otherTodos: InboxTodo[];
    /** Threads waiting for you plus pending to-dos. */
    waits: number;
    errors: string[];
}

export function buildInboxReport(
    args: Omit<InboxReport, "own" | "reviewing" | "waits"> & { seen: MrActivity[] }
): InboxReport {
    const { seen, ...rest } = args;
    const news = seen.filter(hasNews);
    const own = news.filter((a) => a.role === "author");
    const reviewing = news.filter((a) => a.role === "reviewer");
    const waits = news.reduce((sum, a) => sum + a.waiting.length + a.todos.length, 0) + args.otherTodos.length;

    return { ...rest, own, reviewing, waits };
}

/** `22.10 18:04` (dmy) or `2026-10-22 18:04` (iso), in local time. */
export function formatSince(iso: string): string {
    const d = new Date(iso);

    if (getDateStyle() === "dmy") {
        const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        return `${d.getDate()}.${d.getMonth() + 1} ${hm}`;
    }

    return formatLocalDateTimeStamp(d, { seconds: false });
}

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

export function headline(report: InboxReport): string {
    const when = `Since ${formatSince(report.since)} (${formatRelativeTime(new Date(report.since))})`;
    const parts: string[] = [];

    if (report.own.length > 0) {
        parts.push(`${report.own.length} of your MRs`);
    }

    if (report.reviewing.length > 0) {
        parts.push(plural(report.reviewing.length, "MR you review", "MRs you review"));
    }

    const activity =
        parts.length === 0
            ? "nothing new on your MRs or the MRs you review."
            : `${parts.join(" and ")} ${report.own.length + report.reviewing.length === 1 ? "has" : "have"} new activity.`;
    const waits = report.waits > 0 ? ` ${plural(report.waits, "item waits", "items wait")} for you.` : "";

    return `${when}: ${activity}${waits}`;
}

const TODO_ACTIONS: Record<string, string> = {
    review_requested: "review requested",
    review_submitted: "review submitted",
    assigned: "assigned to you",
    mentioned: "mentioned you",
    directly_addressed: "addressed you",
    approval_required: "approval required",
    build_failed: "pipeline failed",
    unmergeable: "cannot be merged",
    marked: "to-do you added",
    member_access_requested: "access requested",
};

function todoLine(todo: InboxTodo): string {
    const action = TODO_ACTIONS[todo.action] ?? todo.action.replace(/_/g, " ");
    return `📌 ${action}${todo.author ? ` by ${todo.author}` : ""}`;
}

function activityLines(a: MrActivity): string[] {
    const facts: string[] = [];

    if (a.comments.length > 0) {
        const total = a.comments.reduce((sum, c) => sum + c.count, 0);
        facts.push(
            `${plural(total, "new comment", "new comments")}: ${a.comments.map((c) => `${c.author} ${c.count}`).join(", ")}`
        );
    }

    if (a.commits > 0) {
        facts.push(`${plural(a.commits, "commit", "commits")} pushed`);
    }

    if (a.approvedBy.length > 0) {
        facts.push(`approved by ${a.approvedBy.join(", ")}`);
    }

    if (a.unapprovedBy.length > 0) {
        facts.push(`approval withdrawn by ${a.unapprovedBy.join(", ")}`);
    }

    if (a.merged) {
        facts.push("merged");
    }

    if (a.closed) {
        facts.push("closed");
    }

    if (a.pipelineFailed) {
        facts.push(`❌ pipeline failed ${a.pipelineFailed.url}`);
    }

    const lines = [`  !${a.mr.iid} ${a.mr.title}  (${a.mr.project})`, `     ${a.mr.webUrl}`];

    if (facts.length > 0) {
        lines.push(`     ${facts.join(" · ")}`);
    }

    for (const thread of a.waiting) {
        lines.push(`     🔴 ${thread.lastAuthor} waits for your reply: ${thread.url}  "${thread.excerpt}"`);
    }

    for (const todo of a.todos) {
        lines.push(`     ${todoLine(todo)}`);
    }

    return lines;
}

export function renderInboxText(report: InboxReport): string {
    const lines = [headline(report)];

    if (report.own.length > 0) {
        lines.push("", "Reviews you received", ...report.own.flatMap(activityLines));
    }

    if (report.reviewing.length > 0) {
        lines.push("", "MRs you review", ...report.reviewing.flatMap(activityLines));
    }

    if (report.otherTodos.length > 0) {
        lines.push("", "Other to-dos", ...report.otherTodos.map((t) => `  ${todoLine(t)}: ${t.title}  ${t.url}`));
    }

    return `${lines.join("\n")}\n`;
}
