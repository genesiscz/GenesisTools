import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { type ProjectRef, projectRefFromRemote } from "@genesiscz/utils/git";
import { type RepoFacts, repoFactsMany } from "@genesiscz/utils/git/repo-facts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { dispatchNotification, type NotificationEvent } from "@genesiscz/utils/notifications";
import { LockTimeoutError, withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { escapeShellArg } from "@genesiscz/utils/string";
import { diffPr, type NotifyItem, type PrMemory, pruneMemory } from "./notify";
import {
    type NotifyConfig,
    type NotifyEvent,
    notifyDir,
    readNotifyConfig,
    repoEvents,
    repoIntervalMinutes,
    watchedRepoPaths,
} from "./notify-config";
import { fetchGithubRepo, fetchGitlabRepo, HostError, type RepoFetch } from "./notify-fetch";

// One poll of every watched repo: fetch, compare with the last poll, post what changed, save.
// Runs from the daemon (`tools hub notify install` registers it) or by hand (`tools hub notify poll`).
// A poll that is not due, or that finds another poll running, returns at once: the daemon may start
// it every minute while the configured interval is longer.

const log = logger.child({ component: "hub/notify-poll" });

/** Keep a GitHub host this far from its hourly GraphQL budget; the rest belongs to the user's other tools. */
const RATE_FLOOR = 300;
const MAX_BACKOFF_MINUTES = 60;
/** Banners per poll; past this the rest fold into one summary so a burst never floods the screen. */
const MAX_BANNERS = 4;
const RECENT_EVENTS = 50;
const REQUEST_LOG = 200;
/** A poll started a little early (the daemon's minute tick) still counts as due. */
const DUE_SLACK_MS = 20_000;

export interface RepoStatus {
    /** The watched checkout this repo was polled through. */
    path?: string;
    failures: number;
    nextAt: string | null;
    lastOkAt: string | null;
    lastError: string | null;
    lastMs: number | null;
    viewer?: string | null;
    /** The last poll of this repo, successful or not; its cadence counts from here. */
    lastAttemptAt?: string;
}

export interface NotifyState {
    lastPollAt: string | null;
    prs: Record<string, PrMemory>;
    repos: Record<string, RepoStatus>;
    hosts: Record<string, { remaining: number; resetAt: string }>;
    recent: Array<NotifyItem & { at: string; posted: boolean }>;
    /** Host calls per poll, for the request-rate figure in `status`. */
    requests: Array<{ at: string; count: number }>;
    /** Watched checkout path to its project key, so a tick reads git facts only for the paths that are due. */
    pathKeys?: Record<string, string>;
}

export interface RepoPollResult {
    key: string;
    path: string;
    provider: "github" | "gitlab" | null;
    prs: number;
    requests: number;
    ms: number;
    error: string | null;
    skipped: string | null;
}

export interface PollReport {
    at: string;
    skipped: string | null;
    dryRun: boolean;
    repos: RepoPollResult[];
    items: NotifyItem[];
    posted: number;
    requests: number;
    elapsedMs: number;
}

export function emptyNotifyState(): NotifyState {
    return { lastPollAt: null, prs: {}, repos: {}, hosts: {}, recent: [], requests: [], pathKeys: {} };
}

export function notifyStatePath(dir = notifyDir()): string {
    return join(dir, "notify-state.json");
}

export function readNotifyState(path = notifyStatePath()): NotifyState {
    if (!existsSync(path)) {
        return emptyNotifyState();
    }

    try {
        const raw = SafeJSON.parse(readFileSync(path, "utf8"));
        return typeof raw === "object" && raw !== null ? { ...emptyNotifyState(), ...raw } : emptyNotifyState();
    } catch (err) {
        log.warn({ err, path }, "notify state unreadable; starting from a fresh baseline");
        return emptyNotifyState();
    }
}

function writeNotifyState(state: NotifyState, path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${SafeJSON.stringify(state, null, 2)}\n`);
}

/** `owner/repo#42` or `group/app!12`: the `--pr` form the hub resolves against its list. */
export function hubPrRef(item: Pick<NotifyItem, "project" | "number" | "provider">): string {
    return `${item.project}${item.provider === "gitlab" ? "!" : "#"}${item.number}`;
}

/**
 * The shell line a banner click runs: the hub's PRs, at `ref` when given (`open -n` hands the flags to a
 * running hub).
 */
export function openHubCommand(ref: string | null, bundle = genesisAppBundlePath()): string {
    return ["/usr/bin/open", "-n", bundle, "--args", "--hub", "--mode", "prs", ...(ref ? ["--pr", ref.trim()] : [])]
        .map(escapeShellArg)
        .join(" ");
}

const TITLES: Record<NotifyEvent, string> = {
    thread: "New review thread",
    ciFailed: "CI failed",
    ciPassed: "CI passed",
    botReview: "Review bot finished",
    merged: "Merged",
};

export type NotifyPoster = (item: NotifyItem, summary?: { more: number }) => Promise<boolean>;

export const postToNotificationCenter: NotifyPoster = async (item, summary) => {
    const ref = hubPrRef(item);
    const repo = item.project.split("/").pop() ?? item.project;

    if (summary) {
        return dispatchNotification({
            app: "hub",
            title: `${summary.more} more PR events`,
            message: "Open the hub's PRs to see them",
            group: "hub-pr-summary",
            execute: openHubCommand(ref),
        });
    }

    return dispatchNotification({
        app: "hub",
        title: `${TITLES[item.type]} · ${repo}${ref.slice(item.project.length)}`,
        subtitle: item.title,
        message: item.message,
        group: `hub-pr-${item.key}`,
        execute: openHubCommand(ref),
    });
};

/** `tools hub notify test`: marked as a test, and its click opens the hub's PRs, at `pr` when given. */
export function testNotification(pr: string | null, bundle = genesisAppBundlePath()): NotificationEvent {
    return {
        app: "hub",
        title: "TEST · hub PR notification",
        subtitle: `This is a test from ${toolCommand("hub notify test")}`,
        message: pr ? `A click opens the hub at ${pr}` : "A click opens the hub's PRs",
        group: "hub-pr-test",
        execute: openHubCommand(pr, bundle),
    };
}

export interface PollDeps {
    /** Test seam: the deadline of one repo job (default `PROJECT_TIMEOUT_MS` on a real timer). */
    projectDeadline?: (key: string) => ProjectDeadline;
    readConfig: () => NotifyConfig;
    readFacts: (paths: string[]) => Promise<RepoFacts[]>;
    fetchGithub: typeof fetchGithubRepo;
    fetchGitlab: typeof fetchGitlabRepo;
    post: NotifyPoster;
    statePath: string;
}

export const realPollDeps = (): PollDeps => ({
    readConfig: () => readNotifyConfig(),
    readFacts: (paths) => repoFactsMany({ paths }),
    fetchGithub: fetchGithubRepo,
    fetchGitlab: fetchGitlabRepo,
    post: postToNotificationCenter,
    statePath: notifyStatePath(),
});

interface WatchedProject {
    key: string;
    path: string;
    project: ProjectRef;
}

/** Watched paths grouped by origin: two worktrees of one repo are polled once. */
export function watchedProjects(facts: RepoFacts[]): { projects: WatchedProject[]; skipped: RepoPollResult[] } {
    const projects = new Map<string, WatchedProject>();
    const skipped: RepoPollResult[] = [];

    for (const fact of facts) {
        const project = fact.origin ? projectRefFromRemote(fact.origin.url) : null;

        if (!project) {
            skipped.push({
                key: fact.path,
                path: fact.path,
                provider: null,
                prs: 0,
                requests: 0,
                ms: 0,
                error: null,
                skipped: fact.root ? "no GitHub or GitLab origin" : "not a git checkout",
            });
            continue;
        }

        const key = `${project.host}/${project.path}`;

        if (!projects.has(key)) {
            projects.set(key, { key, path: fact.path, project });
        }
    }

    return { projects: [...projects.values()], skipped };
}

/** The start of `PollReport.skipped` when no watched repo's cadence has come this tick. */
export const NOT_DUE = "not due";

function factKey(fact: RepoFacts): string | null {
    const project = fact.origin ? projectRefFromRemote(fact.origin.url) : null;
    return project ? `${project.host}/${project.path}` : null;
}

/** A watched path is due when its project is unknown yet, or that project's cadence has come. */
function pathDue(input: { config: NotifyConfig; state: NotifyState; path: string; now: Date }): boolean {
    const key = input.state.pathKeys?.[input.path];
    const status = key ? input.state.repos[key] : undefined;

    if (!key || !status?.lastAttemptAt) {
        return true;
    }

    const cadenceMs = repoIntervalMinutes(input.config, status.path ?? input.path) * 60_000;
    return input.now.getTime() - Date.parse(status.lastAttemptAt) >= cadenceMs - DUE_SLACK_MS;
}

/** A repo's cadence has come: its last poll attempt (or never) is a cadence ago, less the tick slack. */
function repoDue(input: { config: NotifyConfig; state: NotifyState; watched: WatchedProject; now: Date }): boolean {
    const last = input.state.repos[input.watched.key]?.lastAttemptAt;

    if (!last) {
        return true;
    }

    const cadenceMs = repoIntervalMinutes(input.config, input.watched.path) * 60_000;
    return input.now.getTime() - Date.parse(last) >= cadenceMs - DUE_SLACK_MS;
}

/** A repo job that has not answered after this long is recorded as failed, so one hung host never holds the poll
 *  past the daemon task's timeout. */
export const PROJECT_TIMEOUT_MS = 45_000;

export interface ProjectDeadline {
    promise: Promise<void>;
    cancel: () => void;
}

function realProjectDeadline(): ProjectDeadline {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PROJECT_TIMEOUT_MS);
    });
    return { promise, cancel: () => clearTimeout(timer) };
}

type ProjectOutcome =
    | { kind: "skipped"; reason: string }
    | { kind: "fetched"; fetched: RepoFetch; ms: number }
    | { kind: "failed"; err: unknown; ms: number }
    | { kind: "timeout" };

async function pollProject(input: {
    watched: WatchedProject;
    config: NotifyConfig;
    state: NotifyState;
    now: Date;
    at: string;
    force: boolean;
    deps: PollDeps;
}): Promise<ProjectOutcome> {
    const { watched, config, state, now, force, deps } = input;
    const status = state.repos[watched.key];
    const host = state.hosts[watched.project.host];

    if (!force && status?.nextAt && Date.parse(status.nextAt) > now.getTime()) {
        return { kind: "skipped", reason: `backing off until ${status.nextAt} after ${status.failures} failures` };
    }

    if (host && host.remaining < RATE_FLOOR && Date.parse(host.resetAt) > now.getTime()) {
        return { kind: "skipped", reason: `${host.remaining} GraphQL points left until ${host.resetAt}` };
    }

    const repoStarted = performance.now();

    try {
        const fetched =
            watched.project.kind === "github"
                ? await deps.fetchGithub({ project: watched.project, botLogins: config.botLogins })
                : await deps.fetchGitlab({
                      project: watched.project,
                      botLogins: config.botLogins,
                      memory: state.prs,
                      viewer: status?.viewer,
                  });
        return { kind: "fetched", fetched, ms: Math.round(performance.now() - repoStarted) };
    } catch (err) {
        return { kind: "failed", err, ms: Math.round(performance.now() - repoStarted) };
    }
}

/** Records one repo's outcome in the state and the report, and posts its banners (at most `MAX_BANNERS` per poll;
 *  the rest fold into one summary at the end). */
async function finishProject(input: {
    watched: WatchedProject;
    result: ProjectOutcome;
    config: NotifyConfig;
    state: NotifyState;
    now: Date;
    at: string;
    dryRun: boolean;
    deps: PollDeps;
    banners: { posted: number; folded: NotifyItem[] };
    report: PollReport;
}): Promise<void> {
    const { watched, result, config, state, now, at, dryRun, deps, banners, report } = input;
    const status: RepoStatus = state.repos[watched.key] ?? {
        failures: 0,
        nextAt: null,
        lastOkAt: null,
        lastError: null,
        lastMs: null,
    };
    const base: RepoPollResult = {
        key: watched.key,
        path: watched.path,
        provider: watched.project.kind,
        prs: 0,
        requests: 0,
        ms: 0,
        error: null,
        skipped: null,
    };

    if (result.kind === "skipped") {
        report.repos.push({ ...base, skipped: result.reason });
        return;
    }

    if (result.kind === "failed" || result.kind === "timeout") {
        const err = result.kind === "failed" ? result.err : null;
        const message =
            result.kind === "timeout"
                ? `no answer within ${PROJECT_TIMEOUT_MS / 1000} s`
                : err instanceof Error
                  ? err.message
                  : String(err);
        const failures = status.failures + 1;
        const wait = backoffMinutes(
            repoIntervalMinutes(config, watched.path),
            failures,
            err instanceof HostError && err.rateLimited
        );
        const ms = result.kind === "failed" ? result.ms : PROJECT_TIMEOUT_MS;
        state.repos[watched.key] = {
            ...status,
            path: watched.path,
            failures,
            nextAt: iso(now.getTime() + wait * 60_000),
            lastError: message,
            lastMs: ms,
            lastAttemptAt: at,
        };
        log.warn({ err, repo: watched.key, failures, waitMinutes: wait }, "notify poll: repo failed");
        report.repos.push({ ...base, error: message, ms, requests: 1 });
        report.requests += 1;
        return;
    }

    const { fetched, ms } = result;
    const events = repoEvents(config, watched.path);
    const items: NotifyItem[] = [];

    for (const pr of fetched.prs) {
        const diff = diffPr({
            previous: state.prs[pr.key],
            pr,
            viewer: fetched.viewer,
            events,
            onlyMine: config.onlyMine,
            now: at,
        });
        state.prs[pr.key] = diff.memory;
        items.push(...diff.items);
    }

    if (fetched.rate) {
        state.hosts[watched.project.host] = { remaining: fetched.rate.remaining, resetAt: fetched.rate.resetAt };
    }

    state.repos[watched.key] = {
        path: watched.path,
        failures: 0,
        nextAt: null,
        lastOkAt: at,
        lastError: null,
        lastMs: ms,
        viewer: fetched.viewer,
        lastAttemptAt: at,
    };
    report.repos.push({ ...base, prs: fetched.prs.length, requests: fetched.requests, ms });
    report.requests += fetched.requests;
    report.items.push(...items);

    if (dryRun) {
        return;
    }

    for (const item of items) {
        if (banners.posted >= MAX_BANNERS) {
            banners.folded.push(item);
            continue;
        }

        banners.posted += 1;
        const posted = await deps.post(item);
        report.posted += posted ? 1 : 0;
        state.recent.push({ ...item, at, posted });
    }
}

/** Minutes to wait after `failures` failed polls in a row: the interval doubled per failure, capped. */
export function backoffMinutes(intervalMinutes: number, failures: number, rateLimited: boolean): number {
    const doubled = intervalMinutes * 2 ** Math.max(0, failures - 1);
    return Math.min(MAX_BACKOFF_MINUTES, rateLimited ? Math.max(15, doubled) : doubled);
}

function iso(ms: number): string {
    return new Date(ms).toISOString();
}

async function pollLocked({
    now,
    force,
    dryRun,
    deps,
}: {
    now: Date;
    force: boolean;
    dryRun: boolean;
    deps: PollDeps;
}): Promise<PollReport> {
    const started = performance.now();
    const at = now.toISOString();
    const config = deps.readConfig();
    const report: PollReport = {
        at,
        skipped: null,
        dryRun,
        repos: [],
        items: [],
        posted: 0,
        requests: 0,
        elapsedMs: 0,
    };
    const finish = (): PollReport => ({ ...report, elapsedMs: Math.round(performance.now() - started) });

    if (!config.enabled) {
        report.skipped = `notifications are off (${toolCommand("hub notify set", "--enabled", "on")})`;
        return finish();
    }

    const paths = watchedRepoPaths(config);

    if (paths.length === 0) {
        report.skipped = `no repo is watched (${toolCommand("hub notify set", "--repo", "<path>", "--repo-enabled", "on")})`;
        return finish();
    }

    const state = readNotifyState(deps.statePath);
    // Git facts cost a few spawns per checkout, and the task ticks every minute: read them only for the paths whose
    // project is due (or not known yet).
    const factPaths = force ? paths : paths.filter((path) => pathDue({ config, state, path, now }));

    if (factPaths.length === 0) {
        report.skipped = `${NOT_DUE}: no watched repo's cadence has come (${paths.length} watched)`;
        return finish();
    }

    const facts = await deps.readFacts(factPaths);

    const pathKeys = state.pathKeys ?? {};

    for (const fact of facts) {
        const key = factKey(fact);

        if (key) {
            pathKeys[fact.path] = key;
        }
    }

    state.pathKeys = pathKeys;

    const { projects, skipped } = watchedProjects(facts);
    report.repos.push(...skipped);

    // Each repo keeps its own cadence (`intervalMinutes` per repo, else the global one): the daemon task ticks every
    // minute and only the repos whose cadence has come are polled.
    const due = projects.filter((watched) => force || repoDue({ config, state, watched, now }));

    if (due.length === 0) {
        report.skipped = `${NOT_DUE}: no watched repo's cadence has come (${paths.length} watched)`;
        return finish();
    }

    // The due repos run side by side, each with its own state and backoff, and each posts its own banners as soon as
    // it is done: a slow or failing repo never holds back another's news. A repo that has not answered by its
    // deadline is recorded as failed and backs off.
    const deadline = deps.projectDeadline ?? realProjectDeadline;
    const banners = { posted: 0, folded: [] as NotifyItem[] };
    const outcomes = await Promise.allSettled(
        due.map(async (watched) => {
            const timer = deadline(watched.key);
            try {
                const result = await Promise.race([
                    pollProject({ watched, config, state, now, at, force, deps }),
                    timer.promise.then((): ProjectOutcome => ({ kind: "timeout" })),
                ]);
                return finishProject({ watched, result, config, state, now, at, dryRun, deps, banners, report });
            } finally {
                timer.cancel();
            }
        })
    );

    for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
            log.error({ err: outcome.reason }, "notify poll: a repo job failed unexpectedly");
        }
    }

    if (!dryRun) {
        // One left over still gets its own banner; more fold into one summary.
        const [only] = banners.folded;
        if (banners.folded.length === 1 && only) {
            const posted = await deps.post(only);
            report.posted += posted ? 1 : 0;
            state.recent.push({ ...only, at, posted });
        } else if (banners.folded.length > 1) {
            if (banners.folded[0] && (await deps.post(banners.folded[0], { more: banners.folded.length }))) {
                report.posted += 1;
            }

            for (const item of banners.folded) {
                state.recent.push({ ...item, at, posted: false });
            }
        }

        state.recent = state.recent.slice(-RECENT_EVENTS);
        state.requests = [...state.requests, { at, count: report.requests }].slice(-REQUEST_LOG);
        state.prs = pruneMemory(state.prs, now);
        state.lastPollAt = at;
        writeNotifyState(state, deps.statePath);
    }

    const done = finish();
    log.debug(
        {
            repos: done.repos.length,
            items: done.items.length,
            posted: done.posted,
            requests: done.requests,
            ms: done.elapsedMs,
            dryRun,
        },
        "notify poll"
    );
    return done;
}

/**
 * One poll. `force` ignores the interval and every backoff; `dryRun` fetches and compares but
 * neither posts nor saves, so the next real poll still sees the same changes.
 */
export async function pollNotify({
    now = new Date(),
    force = false,
    dryRun = false,
    deps = realPollDeps(),
}: {
    now?: Date;
    force?: boolean;
    dryRun?: boolean;
    deps?: PollDeps;
} = {}): Promise<PollReport> {
    mkdirSync(dirname(deps.statePath), { recursive: true });

    try {
        return await withFileLock(`${deps.statePath}.poll`, () => pollLocked({ now, force, dryRun, deps }), 2000);
    } catch (err) {
        if (err instanceof LockTimeoutError) {
            return {
                at: now.toISOString(),
                skipped: "another poll is running",
                dryRun,
                repos: [],
                items: [],
                posted: 0,
                requests: 0,
                elapsedMs: 0,
            };
        }

        throw err;
    }
}

export interface NotifyStatus {
    config: NotifyConfig;
    configPath: string;
    statePath: string;
    lastPollAt: string | null;
    nextPollAt: string | null;
    repos: Record<string, RepoStatus>;
    hosts: NotifyState["hosts"];
    recent: NotifyState["recent"];
    /** Host calls in the last hour, from the per-poll request log. */
    requestsLastHour: number;
    pollsLastHour: number;
    daemonTask: boolean | null;
}

export function notifyStatus({
    config = readNotifyConfig(),
    statePath = notifyStatePath(),
    configPath,
    now = new Date(),
    daemonTask = null,
}: {
    config?: NotifyConfig;
    statePath?: string;
    configPath: string;
    now?: Date;
    daemonTask?: boolean | null;
}): NotifyStatus {
    const state = readNotifyState(statePath);
    const hourAgo = now.getTime() - 60 * 60_000;
    const lastHour = state.requests.filter((entry) => Date.parse(entry.at) >= hourAgo);
    return {
        config,
        configPath,
        statePath,
        lastPollAt: state.lastPollAt,
        nextPollAt: state.lastPollAt ? iso(Date.parse(state.lastPollAt) + config.intervalMinutes * 60_000) : null,
        repos: state.repos,
        hosts: state.hosts,
        recent: state.recent.slice().reverse(),
        requestsLastHour: lastHour.reduce((sum, entry) => sum + entry.count, 0),
        pollsLastHour: lastHour.length,
        daemonTask,
    };
}
