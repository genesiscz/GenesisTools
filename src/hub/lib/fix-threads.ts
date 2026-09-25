import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execTool } from "@genesiscz/utils/cli";
import { fetchCmuxLiveSnapshot } from "@genesiscz/utils/cmux/lib/live-snapshot";
import { lookupSessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { backendFor, type FoundPr, HubPrError, type PrThread, prThreads, resolvePr, type ThreadsResult } from "./pr";
import { type PrSessionMatch, type PrSessionReason, type PrSessionsInput, prSessions } from "./pr-sessions";

const log = logger.child({ component: "hub/fix-threads" });

/** How strongly a reason says the session works on the branch (the owner), not only near it. */
const REASON_WEIGHT: Record<PrSessionReason, number> = { worktree: 4, branch: 4, commits: 2, files: 1 };
const MAX_CANDIDATES = 8;

/** A session that could take the task: one of the PR's sessions, and whether cmux has it open now. */
export interface FixOwner {
    provider: string;
    sessionId: string;
    title: string | null;
    cwd: string;
    mtime: string;
    reasons: PrSessionReason[];
    /** Its recorded cmux surface is in the live cmux tree, so `send` can type into it. */
    live: boolean;
}

/** One task handed to the session that owns a PR's branch: its file, its one-line prompt, where it went. */
export interface PrTaskResult {
    pr: { label: string; url: string; title: string; branch: string };
    /** The task file the prompt points at; written unless `dryRun`. */
    file: string;
    written: boolean;
    /** The one line typed into the session: it names the file, never the task text. */
    prompt: string;
    /** Where the prompt goes: `session` when given, else the best live candidate. */
    owner: FixOwner | null;
    candidates: FixOwner[];
    sent: boolean;
    focused: boolean;
    /** Why nothing was sent, or why the focus failed after a send. */
    error: string | null;
}

export interface FixThreadsResult extends PrTaskResult {
    threads: Array<{ id: string; path: string; line: number; resolved: boolean; outdated: boolean }>;
    /** Asked-for ids the PR does not have (resolved away, or a stale list). */
    missing: string[];
}

export interface FixThreadsInput {
    /** The checkout of the PR (the review window's repo). */
    repo: string;
    /** The PR's URL or `<repoPath>#<n>`; default: the branch's PR at `repo`. */
    pr?: string;
    ids: string[];
    /** Send to this session instead of the best candidate. */
    session?: string;
    dryRun?: boolean;
    /** Write the file and stop: the caller starts a new agent with `prompt` (the hub's "New agent"). */
    send?: boolean;
    focus?: boolean;
    /** Raise the cmux app after the focus (off for scripted checks). */
    activate?: boolean;
}

export interface FixThreadsDeps {
    pr: (input: { repo: string; pr?: string }) => Promise<FoundPr>;
    threads: (pr: FoundPr) => Promise<ThreadsResult>;
    sessions: (input: PrSessionsInput) => Promise<PrSessionMatch[]>;
    /** The ids among `sessionIds` that cmux has open now. */
    live: (sessionIds: string[]) => Promise<Set<string>>;
    write: (file: string, text: string) => Promise<void>;
    send: (sessionId: string, text: string) => Promise<string | null>;
    focus: (sessionId: string, activate: boolean) => Promise<string | null>;
    dir: string;
    now: () => Date;
}

/** What sending a task needs: everything but reading the PR and its threads. */
export type PrTaskDeps = Omit<FixThreadsDeps, "pr" | "threads">;

export interface PrTaskInput {
    /** The checkout of the PR: where the sessions are searched and a new agent starts. */
    repo: string;
    pr: FoundPr;
    /** The task file's text; written unless `dryRun`. */
    markdown: string;
    /** The one line typed into the session, given the task file's path. */
    prompt: (file: string) => string;
    /** For the log: what the task is ("3 threads", "check CI / test"). */
    what: string;
    session?: string;
    dryRun?: boolean;
    send?: boolean;
    focus?: boolean;
    activate?: boolean;
}

export function prLabel(pr: Pick<FoundPr, "provider" | "number">): string {
    return pr.provider === "gitlab" ? `!${pr.number}` : `#${pr.number}`;
}

/** The asked-for threads in the PR's own order, and the ids it does not have. */
export function selectThreads(threads: PrThread[], ids: string[]): { selected: PrThread[]; missing: string[] } {
    const wanted = new Set(ids);
    const selected = threads.filter((thread) => wanted.has(thread.id));
    const found = new Set(selected.map((thread) => thread.id));
    return { selected, missing: ids.filter((id) => !found.has(id)) };
}

function quote(text: string): string {
    return text
        .trimEnd()
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
}

/** The task file: every thread with its place, its notes and its hunk, then what to do and what not to do. */
export function fixThreadsMarkdown({ pr, threads, repo }: { pr: FoundPr; threads: PrThread[]; repo: string }): string {
    const label = prLabel(pr);
    const lines = [
        `# Fix ${threads.length} review ${threads.length === 1 ? "thread" : "threads"} on ${label}: ${pr.title}`,
        "",
        `- PR: ${pr.webUrl || pr.url}`,
        `- Branch: \`${pr.sourceBranch}\` into \`${pr.targetBranch}\``,
        `- Checkout: \`${repo}\``,
        "",
        "Change the code so that each thread below is addressed. Paths are relative to the checkout.",
        "Do not reply on the PR, resolve threads, or submit a review: the reviewer does that in the hub.",
        "When you are done, list each thread with what you changed, or why you changed nothing.",
    ];

    threads.forEach((thread, index) => {
        const range =
            thread.startLine && thread.startLine < thread.line
                ? `${thread.startLine}-${thread.line}`
                : `${thread.line}`;
        const state = [
            thread.resolved ? "resolved" : "open",
            thread.outdated ? "outdated" : null,
            thread.side === "deletions" ? "old side" : null,
        ]
            .filter(Boolean)
            .join(", ");
        lines.push("", `## ${index + 1}. \`${thread.path}:${range}\` (${state})`, "", `Thread id: \`${thread.id}\``);

        for (const comment of thread.comments) {
            const who = comment.author.username ? `@${comment.author.username}` : comment.author.name;
            lines.push(
                "",
                `**${who}**${comment.isDraft ? " (pending draft)" : ""}, ${comment.createdAt}:`,
                "",
                quote(comment.bodyMarkdown)
            );
        }

        if (thread.diffHunk) {
            lines.push("", "```diff", thread.diffHunk.trimEnd(), "```");
        }
    });

    return `${lines.join("\n")}\n`;
}

/** One line, so nothing multi-line is typed into the agent's prompt. */
export function fixThreadsPrompt({ file, count, label }: { file: string; count: number; label: string }): string {
    return `Fix the ${count} review ${count === 1 ? "thread" : "threads"} of ${label} listed in ${file}: read that file and change the code for each one.`;
}

/** Live first, then the reasons that mean "works on this branch", then the newest. */
export function rankOwners(matches: PrSessionMatch[], live: ReadonlySet<string>): FixOwner[] {
    const weight = (match: PrSessionMatch) => Math.max(0, ...match.reasons.map((reason) => REASON_WEIGHT[reason] ?? 0));
    return [...matches]
        .sort(
            (a, b) =>
                Number(live.has(b.sessionId)) - Number(live.has(a.sessionId)) ||
                weight(b) - weight(a) ||
                b.mtime.localeCompare(a.mtime)
        )
        .slice(0, MAX_CANDIDATES)
        .map((match) => ({
            provider: match.provider,
            sessionId: match.sessionId,
            title: match.title,
            cwd: match.cwd,
            mtime: match.mtime,
            reasons: match.reasons,
            live: live.has(match.sessionId),
        }));
}

export function fixThreadsFile({ dir, pr, now }: { dir: string; pr: FoundPr; now: Date }): string {
    const slug = `${pr.project}-${pr.number}`.replace(/[^A-Za-z0-9._-]+/g, "_");
    return join(dir, `${slug}-${now.toISOString().replace(/[:.]/g, "-")}.md`);
}

/**
 * "Fix these threads": the chosen review threads go into one task file, and one line naming it is
 * typed into the session that owns the branch, whose cmux pane is then focused. Nothing is written
 * to the PR. `send: false` only writes the file (the hub then starts a new agent with the prompt).
 */
export async function fixThreads(input: FixThreadsInput, deps: FixThreadsDeps): Promise<FixThreadsResult> {
    if (input.ids.length === 0) {
        throw new HubPrError("bad-input", "--threads needs at least one thread id");
    }

    const pr = await deps.pr({ repo: input.repo, pr: input.pr });
    const { threads } = await deps.threads(pr);
    const { selected, missing } = selectThreads(threads, input.ids);

    if (selected.length === 0) {
        throw new HubPrError("not-found", `${prLabel(pr)} has none of the threads ${input.ids.join(", ")}`);
    }

    const task = await sendPrTask(
        {
            repo: input.repo,
            pr,
            markdown: fixThreadsMarkdown({ pr, threads: selected, repo: input.repo }),
            prompt: (file) => fixThreadsPrompt({ file, count: selected.length, label: prLabel(pr) }),
            what: `${selected.length} threads`,
            session: input.session,
            dryRun: input.dryRun,
            send: input.send,
            focus: input.focus,
            activate: input.activate,
        },
        deps
    );
    return {
        ...task,
        threads: selected.map(({ id, path, line, resolved, outdated }) => ({ id, path, line, resolved, outdated })),
        missing,
    };
}

/**
 * One task to the session that owns the PR's branch: the task file is written, one line naming it
 * is typed into the owner's cmux pane, and the pane is focused. The owner is `session` when given,
 * else the best live session that worked on the branch. `send: false` only writes the file (the hub
 * then starts a new agent with the prompt). Nothing is written to the PR.
 */
export async function sendPrTask(input: PrTaskInput, deps: PrTaskDeps): Promise<PrTaskResult> {
    const { pr } = input;
    const label = prLabel(pr);
    const file = fixThreadsFile({ dir: deps.dir, pr, now: deps.now() });
    const prompt = input.prompt(file);
    // An explicit session needs no search; the plan (dry run) and "pick the owner" do.
    const needsCandidates = input.dryRun || (input.send !== false && !input.session);
    const matches = needsCandidates
        ? await deps.sessions({ repoRoot: input.repo, headBranch: pr.sourceBranch, base: pr.baseSha, head: pr.headSha })
        : [];
    const live = await deps.live([
        ...matches.map((match) => match.sessionId),
        ...(input.session ? [input.session] : []),
    ]);
    const candidates = rankOwners(matches, live);
    const explicit = input.session
        ? (candidates.find((candidate) => candidate.sessionId === input.session) ?? {
              provider: "claude",
              sessionId: input.session,
              title: null,
              cwd: input.repo,
              mtime: "",
              reasons: [],
              live: live.has(input.session),
          })
        : null;
    const owner = explicit ?? candidates.find((candidate) => candidate.live) ?? candidates[0] ?? null;
    const result: PrTaskResult = {
        pr: { label, url: pr.webUrl || pr.url, title: pr.title, branch: pr.sourceBranch },
        file,
        written: false,
        prompt,
        owner,
        candidates,
        sent: false,
        focused: false,
        error: null,
    };
    log.debug(
        {
            pr: pr.url,
            what: input.what,
            owner: owner?.sessionId,
            candidates: candidates.length,
            dryRun: input.dryRun,
        },
        "pr task: planned"
    );

    if (input.dryRun) {
        return result;
    }

    await deps.write(file, input.markdown);
    result.written = true;

    if (input.send === false) {
        return result;
    }

    if (!owner) {
        result.error = "no session worked on this branch; start one with the prompt";
        return result;
    }

    if (!input.session && !owner.live) {
        result.error = `no session that owns ${pr.sourceBranch} is open in cmux; resume ${owner.sessionId.slice(0, 8)} or start one`;
        return result;
    }

    const sendError = await deps.send(owner.sessionId, prompt);

    if (sendError) {
        result.error = `send to ${owner.sessionId.slice(0, 8)} failed: ${sendError}`;
        return result;
    }

    result.sent = true;
    log.debug({ session: owner.sessionId, file, what: input.what }, "pr task: sent");

    if (input.focus !== false) {
        const focusError = await deps.focus(owner.sessionId, input.activate !== false);
        result.focused = focusError === null;
        result.error = focusError ? `sent, but the focus failed: ${focusError}` : null;
    }

    return result;
}

/** The sessions whose hook-recorded cmux surface is still in the live tree (one cmux call). */
async function liveSessions(sessionIds: string[]): Promise<Set<string>> {
    const recorded = sessionIds
        .map((id) => ({ id, refs: lookupSessionCmuxRefs(id) }))
        .filter((entry) => entry.refs?.surfaceId || entry.refs?.surfaceRef);

    if (recorded.length === 0) {
        return new Set();
    }

    const snapshot = await fetchCmuxLiveSnapshot({ previews: "none" });

    if (!snapshot.available) {
        log.debug({ error: snapshot.error }, "fix threads: cmux is not reachable; no session counts as live");
        return new Set();
    }

    const surfaces = new Set(snapshot.panes.flatMap((pane) => pane.surfaces.map((surface) => surface.id)));
    return new Set(
        recorded
            .filter(({ refs }) =>
                [refs?.surfaceId, refs?.surfaceRef].some((surface) => surface && surfaces.has(surface))
            )
            .map(({ id }) => id)
    );
}

/**
 * `tools claude cmux send|focus` in their own process: both exit the process on a cmux failure and
 * print tables for an ambiguous match, which must not end this command or reach its JSON on stdout.
 */
async function cmuxVerb(args: string[]): Promise<string | null> {
    log.debug({ args: args.slice(0, 3) }, "fix threads: tools claude cmux");
    const run = await execTool(["claude", "cmux", ...args, "--first", "--json"], { timeout: 30_000 });

    if (run.success) {
        return null;
    }

    const reason = noPaneMatched(run.stdout) ? "no cmux pane runs this session" : run.stderr || run.stdout;
    return reason.split("\n").slice(-3).join(" ").slice(0, 300) || `exit ${run.exitCode}`;
}

/** `{ matches: [] }`: the verb's JSON for "no pane matches this session". */
export function noPaneMatched(stdout: string): boolean {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(stdout, { strict: true });
    } catch (error) {
        log.debug({ error }, "fix threads: the cmux verb printed no JSON");
        return false;
    }

    if (typeof parsed !== "object" || parsed === null || !("matches" in parsed)) {
        return false;
    }

    return Array.isArray(parsed.matches) && parsed.matches.length === 0;
}

export const realFixThreadsDeps: FixThreadsDeps = {
    pr: (input) => resolvePr(input),
    threads: async (pr) => prThreads({ pr, backend: await backendFor(pr) }),
    sessions: async (input) => (await prSessions({ input })).sessions,
    live: liveSessions,
    write: async (file, text) => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text);
    },
    send: (sessionId, text) => cmuxVerb(["send", sessionId, text]),
    focus: (sessionId, activate) => cmuxVerb(["focus", sessionId, ...(activate ? [] : ["--no-activate"])]),
    dir: join(new Storage("hub").getBaseDir(), "fix-threads"),
    now: () => new Date(),
};
