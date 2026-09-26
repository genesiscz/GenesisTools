import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { type DecisionRecord, readDecisions } from "@app/question/lib/decisions/store";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { buildTimeline, git, startOfDay, TIMELINE_LIMITS, type TimelineEvent, type TimelineResult } from "./timeline";

// `tools hub digest`: what the agents did on one day, built from the Activity feed (`buildTimeline`,
// the same sources the hub's Activity mode reads) plus one `git log --numstat` per repository for
// the files changed, and the decisions store for what was posted and answered.

const log = logger.child({ component: "hub/digest" });

export interface DigestWindow {
    since: Date;
    until: Date;
}

export interface DigestSession {
    sessionId: string;
    provider: string | null;
    title: string;
    project: string | null;
    cwd: string | null;
    branch: string | null;
    startedAt: string | null;
    lastAt: string;
    commits: number;
}

export interface DigestCommit {
    sha: string;
    subject: string;
    at: string;
    project: string | null;
    repo: string | null;
    author: string | null;
    /** The session that worked in this repository around the commit's time, when exactly one did. */
    sessionId: string | null;
}

export interface DigestRepoFiles {
    repo: string;
    project: string;
    files: number;
    added: number;
    removed: number;
    /** The most changed paths, at most `DIGEST_LIMITS.paths`. */
    paths: Array<{ path: string; added: number; removed: number }>;
}

export interface DigestPr {
    ref: string;
    title: string;
    url: string | null;
    project: string | null;
    at: string;
}

export interface DigestDecision {
    id: string;
    number: number;
    title: string;
    state: string;
    sessionId: string;
    project: string | null;
    at: string;
    answer: string | null;
}

export interface Digest {
    date: string;
    since: string;
    until: string;
    sessions: DigestSession[];
    commits: DigestCommit[];
    files: { total: number; added: number; removed: number; repos: DigestRepoFiles[] };
    prs: { opened: DigestPr[]; merged: DigestPr[] };
    decisions: { posted: DigestDecision[]; answered: DigestDecision[] };
    ci: { failed: number; passed: number };
    pushes: number;
    warnings: string[];
    generatedAt: string;
}

export const DIGEST_LIMITS = { paths: 12, attributionSlackMs: 10 * 60_000 };

export interface DigestDeps {
    timeline: (window: DigestWindow, prs: boolean) => Promise<TimelineResult>;
    /** `git log --numstat --format=` over the window for one repository (every branch, no merges). */
    numstat: (repo: string, window: DigestWindow) => Promise<string>;
    decisions: () => DecisionRecord[];
}

export const realDigestDeps: DigestDeps = {
    timeline: (window, prs) =>
        buildTimeline({
            since: window.since,
            until: window.until,
            limit: TIMELINE_LIMITS.pageMax,
            filters: { author: "all" },
            prs,
        }),
    numstat: async (repo, window) => {
        const email = (await git(["config", "user.email"], repo).catch(() => "")).trim();
        const args = [
            "log",
            "--all",
            "--no-merges",
            `--since=${window.since.toISOString()}`,
            `--until=${window.until.toISOString()}`,
            "--numstat",
            "--format=",
        ];

        if (email) {
            args.push(`--author=${email}`);
        }

        return git(args, repo);
    },
    decisions: () => readDecisions(decisionFiles().file),
};

/** `today`, `yesterday` or `YYYY-MM-DD` into that local day; null for anything else. */
export function digestDay(value: string | undefined, now = new Date()): DigestWindow | null {
    const text = (value ?? "today").trim().toLowerCase();
    let start: Date;

    if (text === "today") {
        start = startOfDay(now);
    } else if (text === "yesterday") {
        start = startOfDay(now);
        start.setDate(start.getDate() - 1);
    } else {
        const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);

        if (!match) {
            return null;
        }

        start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

        if (Number.isNaN(start.getTime()) || start.getDate() !== Number(match[3])) {
            return null;
        }
    }

    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    // Today ends now: a window into the future makes the live page cache miss on every call.
    return { since: start, until: end.getTime() > now.getTime() ? now : end };
}

export function localDate(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `git log --numstat --format=` output into per-path totals (binary files count as 0/0). */
export function parseNumstat(text: string): Map<string, { added: number; removed: number }> {
    const paths = new Map<string, { added: number; removed: number }>();

    for (const line of text.split("\n")) {
        const parts = line.split("\t");

        if (parts.length < 3) {
            continue;
        }

        const path = parts.slice(2).join("\t").trim();

        if (!path) {
            continue;
        }

        const added = Number.parseInt(parts[0], 10) || 0;
        const removed = Number.parseInt(parts[1], 10) || 0;
        const previous = paths.get(path) ?? { added: 0, removed: 0 };
        paths.set(path, { added: previous.added + added, removed: previous.removed + removed });
    }

    return paths;
}

function within(ts: string | undefined, window: DigestWindow): boolean {
    if (!ts) {
        return false;
    }

    const at = Date.parse(ts);
    return at >= window.since.getTime() && at < window.until.getTime();
}

const ANSWERED = new Set(["answered", "sent", "acknowledged", "implemented"]);

function decisionRow(row: DecisionRecord, at: string): DigestDecision {
    return {
        id: row.id,
        number: row.number,
        title: row.title ?? row.prompt.split("\n")[0].slice(0, 160),
        state: row.state,
        sessionId: row.sessionId,
        project: row.project ?? (row.cwd ? basename(row.cwd) : null),
        at,
        answer: row.option ? `${row.option})${row.answer ? ` ${row.answer}` : ""}` : (row.answer ?? null),
    };
}

/** Decisions whose post (createdTs) or answer (updatedTs in an answered state) falls in the window. */
export function digestDecisions(
    rows: readonly DecisionRecord[],
    window: DigestWindow
): { posted: DigestDecision[]; answered: DigestDecision[] } {
    const posted: DigestDecision[] = [];
    const answered: DigestDecision[] = [];

    for (const row of rows) {
        if (row.type === "todo") {
            continue;
        }

        if (row.createdTs && within(row.createdTs, window)) {
            posted.push(decisionRow(row, row.createdTs));
        }

        if (ANSWERED.has(row.state) && within(row.updatedTs, window)) {
            answered.push(decisionRow(row, row.updatedTs));
        }
    }

    const newest = (left: DigestDecision, right: DigestDecision) => right.at.localeCompare(left.at);
    return { posted: posted.sort(newest), answered: answered.sort(newest) };
}

interface SessionSpan {
    session: DigestSession;
    repo: string | null;
    from: number;
    to: number;
}

/** The one session that worked in `repo` around `at`; null when none or several did. */
function attribute(spans: readonly SessionSpan[], repo: string | null, at: number): string | null {
    if (!repo) {
        return null;
    }

    const matches = spans.filter(
        (span) =>
            span.repo === repo &&
            at >= span.from - DIGEST_LIMITS.attributionSlackMs &&
            at <= span.to + DIGEST_LIMITS.attributionSlackMs
    );
    return matches.length === 1 ? matches[0].session.sessionId : null;
}

function prOf(event: TimelineEvent): DigestPr {
    return {
        ref: event.pr?.ref ?? event.title,
        title: event.title,
        url: event.pr?.url ?? event.url ?? null,
        project: event.project,
        at: event.at,
    };
}

/** Everything but the files: the feed's events folded into the digest's sections. */
export function digestFromTimeline({
    window,
    timeline,
    decisions,
    now = new Date(),
}: {
    window: DigestWindow;
    timeline: TimelineResult;
    decisions: readonly DecisionRecord[];
    now?: Date;
}): Digest {
    const sessions = new Map<string, SessionSpan>();
    const events = [...timeline.events].sort((left, right) => left.at.localeCompare(right.at));

    for (const event of events) {
        if ((event.kind !== "session.start" && event.kind !== "session.turn") || !event.sessionId) {
            continue;
        }

        const at = Date.parse(event.at);
        const known = sessions.get(event.sessionId);

        if (known) {
            known.from = Math.min(known.from, at);
            known.to = Math.max(known.to, at);
            known.session.lastAt = new Date(known.to).toISOString();
            known.session.startedAt = event.kind === "session.start" ? event.at : known.session.startedAt;
            known.session.branch = event.branch ?? known.session.branch;
            continue;
        }

        sessions.set(event.sessionId, {
            repo: event.repo,
            from: at,
            to: at,
            session: {
                sessionId: event.sessionId,
                provider: event.provider ?? null,
                title: event.title,
                project: event.project,
                cwd: event.cwd ?? null,
                branch: event.branch ?? null,
                startedAt: event.kind === "session.start" ? event.at : null,
                lastAt: event.at,
                commits: 0,
            },
        });
    }

    const spans = [...sessions.values()];
    const commits: DigestCommit[] = events
        .filter((event) => event.kind === "commit" && event.sha && event.mine !== false)
        .map((event) => {
            const sessionId = attribute(spans, event.repo, Date.parse(event.at));
            const span = sessionId ? sessions.get(sessionId) : undefined;

            if (span) {
                span.session.commits += 1;
            }

            return {
                sha: event.sha!,
                subject: event.title,
                at: event.at,
                project: event.project,
                repo: event.repo,
                author: event.author ?? null,
                sessionId,
            };
        })
        .reverse();

    const prEvents = events.filter((event) => event.kind === "pr");
    const opened = prEvents
        .filter((event) => event.id.startsWith("pr-open:"))
        .map(prOf)
        .reverse();
    const merged = prEvents
        .filter((event) => event.id.startsWith("pr-merged:"))
        .map(prOf)
        .reverse();
    const ci = events.filter((event) => event.kind === "ci");

    return {
        date: localDate(window.since),
        since: window.since.toISOString(),
        until: window.until.toISOString(),
        sessions: spans.map((span) => span.session).sort((left, right) => right.lastAt.localeCompare(left.lastAt)),
        commits,
        files: { total: 0, added: 0, removed: 0, repos: [] },
        prs: { opened, merged },
        decisions: digestDecisions(decisions, window),
        ci: {
            failed: ci.filter((event) => event.state === "failed").length,
            passed: ci.filter((event) => event.state === "success").length,
        },
        pushes: events.filter((event) => event.kind === "push").length,
        warnings: [...timeline.warnings, ...(timeline.hasMore ? ["the day has more events than one feed page"] : [])],
        generatedAt: now.toISOString(),
    };
}

export function repoFiles(repo: string, numstat: string): DigestRepoFiles {
    const paths = [...parseNumstat(numstat).entries()].map(([path, counts]) => ({ path, ...counts }));
    paths.sort((left, right) => right.added + right.removed - (left.added + left.removed));

    return {
        repo,
        project: basename(repo),
        files: paths.length,
        added: paths.reduce((sum, entry) => sum + entry.added, 0),
        removed: paths.reduce((sum, entry) => sum + entry.removed, 0),
        paths: paths.slice(0, DIGEST_LIMITS.paths),
    };
}

export async function buildDigest({
    window,
    prs = true,
    deps = realDigestDeps,
    now = new Date(),
}: {
    window: DigestWindow;
    prs?: boolean;
    deps?: DigestDeps;
    now?: Date;
}): Promise<Digest> {
    const started = performance.now();
    const timeline = await deps.timeline(window, prs);
    const digest = digestFromTimeline({ window, timeline, decisions: deps.decisions(), now });
    const repos = [
        ...new Set(
            [...timeline.repos, ...digest.commits.map((commit) => commit.repo)].filter((repo): repo is string =>
                Boolean(repo)
            )
        ),
    ];

    const files = await Promise.all(
        repos.map(async (repo) => {
            try {
                return repoFiles(repo, await deps.numstat(repo, window));
            } catch (error) {
                log.debug({ error, repo }, "digest: numstat failed");
                digest.warnings.push(
                    `files of ${basename(repo)}: ${error instanceof Error ? error.message : String(error)}`
                );
                return null;
            }
        })
    );
    const changed = files.filter((entry): entry is DigestRepoFiles => entry !== null && entry.files > 0);
    changed.sort((left, right) => right.files - left.files);
    digest.files = {
        total: changed.reduce((sum, entry) => sum + entry.files, 0),
        added: changed.reduce((sum, entry) => sum + entry.added, 0),
        removed: changed.reduce((sum, entry) => sum + entry.removed, 0),
        repos: changed,
    };

    log.debug(
        {
            date: digest.date,
            sessions: digest.sessions.length,
            commits: digest.commits.length,
            repos: repos.length,
            files: digest.files.total,
            ms: Math.round(performance.now() - started),
        },
        "digest built"
    );
    return digest;
}

function time(iso: string): string {
    return new Date(iso).toTimeString().slice(0, 5);
}

/** The digest as a markdown note (the vault export and `--markdown`). */
export function digestMarkdown(digest: Digest): string {
    const lines: string[] = [`# Agents digest ${digest.date}`, ""];
    const summary = [
        `${digest.sessions.length} sessions`,
        `${digest.commits.length} commits`,
        `${digest.files.total} files (+${digest.files.added} −${digest.files.removed})`,
        `${digest.prs.opened.length} PRs opened`,
        `${digest.prs.merged.length} merged`,
        `${digest.decisions.posted.length} decisions posted`,
        `${digest.decisions.answered.length} answered`,
    ];
    lines.push(summary.join(" · "), "");

    lines.push("## Sessions", "");
    for (const session of digest.sessions) {
        const where = [session.provider, session.project, session.branch].filter(Boolean).join(" · ");
        const commits = session.commits > 0 ? ` · ${session.commits} commits` : "";
        lines.push(`- ${time(session.lastAt)} **${session.title}** (${where})${commits} \`${session.sessionId}\``);
    }
    if (digest.sessions.length === 0) {
        lines.push("- none");
    }

    lines.push("", "## Commits", "");
    for (const commit of digest.commits) {
        lines.push(`- ${time(commit.at)} \`${commit.sha.slice(0, 10)}\` ${commit.subject} (${commit.project ?? "?"})`);
    }
    if (digest.commits.length === 0) {
        lines.push("- none");
    }

    lines.push("", "## Files changed", "");
    for (const repo of digest.files.repos) {
        lines.push(`- **${repo.project}**: ${repo.files} files, +${repo.added} −${repo.removed}`);
        for (const path of repo.paths) {
            lines.push(`  - \`${path.path}\` +${path.added} −${path.removed}`);
        }
    }
    if (digest.files.repos.length === 0) {
        lines.push("- none");
    }

    lines.push("", "## Pull requests", "");
    for (const pr of digest.prs.opened) {
        lines.push(`- opened ${pr.url ? `[${pr.ref}](${pr.url})` : pr.ref}: ${pr.title}`);
    }
    for (const pr of digest.prs.merged) {
        lines.push(`- merged ${pr.url ? `[${pr.ref}](${pr.url})` : pr.ref}: ${pr.title}`);
    }
    if (digest.prs.opened.length + digest.prs.merged.length === 0) {
        lines.push("- none");
    }

    lines.push("", "## Decisions", "");
    for (const decision of digest.decisions.posted) {
        lines.push(`- posted #${decision.number} ${decision.title} (${decision.state})`);
    }
    for (const decision of digest.decisions.answered) {
        lines.push(`- answered #${decision.number} ${decision.title}${decision.answer ? `: ${decision.answer}` : ""}`);
    }
    if (digest.decisions.posted.length + digest.decisions.answered.length === 0) {
        lines.push("- none");
    }

    if (digest.ci.failed + digest.ci.passed > 0 || digest.pushes > 0) {
        lines.push("", `CI: ${digest.ci.failed} failed, ${digest.ci.passed} passed · ${digest.pushes} pushes`);
    }

    if (digest.warnings.length > 0) {
        lines.push("", "> [!warning] Incomplete", ...digest.warnings.map((warning) => `> ${warning}`));
    }

    lines.push("", `_Generated ${digest.generatedAt} by tools hub digest._`, "");
    return lines.join("\n");
}

export interface DigestConfig {
    /** The folder the export writes to (a vault folder); null until set. */
    folder: string | null;
}

/** The hub config key (`~/.genesis-tools/hub/config.json`, beside `tools hub config`'s settings). */
export const DIGEST_FOLDER_KEY = "digestFolder";

export function digestConfigPath(storage = new Storage("hub")): string {
    return `${storage.getConfigPath()} (${DIGEST_FOLDER_KEY})`;
}

function expandHome(path: string): string {
    return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export async function readDigestConfig(storage = new Storage("hub")): Promise<DigestConfig> {
    const folder = await storage.getConfigValue<unknown>(DIGEST_FOLDER_KEY);
    return { folder: typeof folder === "string" && folder.trim() ? folder : null };
}

export async function writeDigestConfig(config: DigestConfig, storage = new Storage("hub")): Promise<DigestConfig> {
    const folder = config.folder ? resolve(expandHome(config.folder)) : null;
    await storage.setConfigValue(DIGEST_FOLDER_KEY, folder);
    return { folder };
}

export function digestFileName(date: string): string {
    return `${date} Agents digest.md`;
}

/** Writes the note into `folder` (created when missing); returns the file's path. */
export function exportDigest(digest: Digest, folder: string): string {
    const dir = resolve(expandHome(folder));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, digestFileName(digest.date));
    atomicWriteFileSync(path, digestMarkdown(digest));
    log.info({ path, date: digest.date }, "digest exported");
    return path;
}
