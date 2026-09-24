/**
 * GitLab REST and GraphQL for any instance. Nothing is hardcoded: the host, the token and the
 * project are resolved per call site from flags, the environment, glab and the git checkout.
 *
 *   host:    --host → GITLAB_HOST → `glab config get host`
 *   token:   GITLAB_TOKEN → `glab config get token --host <hostname>` → `glab auth token --hostname <hostname>`
 *   project: --project → GITLAB_PROJECT → the `origin` remote, when it points at the resolved host
 */

import { gitRepoRoot, gitResult } from "@app/gitlab/lib/git";
import { HttpError, isRetryableError } from "@app/gitlab/lib/http";
import { fetchAllPages, type Page, parseNextPage } from "@app/gitlab/lib/paginate";
import { pool } from "@app/gitlab/lib/pool";
import { retry } from "@genesiscz/utils/async";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/** `host` is `https://gitlab.example.com`, no trailing slash. */
export interface GitLabApi {
    host: string;
    token: string;
}

/** `project` is `group/sub/name` or a numeric id. */
export interface ProjectApi extends GitLabApi {
    project: string;
}

// ─── host ──────────────────────────────────────────────────────────────────────

/** `gitlab.example.com`, `https://gitlab.example.com/` and `https://gitlab.example.com/gitlab` all normalise; http stays http. */
export function normalizeHost(value: string): string {
    const trimmed = value.trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);

    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** `gitlab.example.com` (with the port when there is one): the key glab stores per-host settings under. */
export function hostnameOf(host: string): string {
    return new URL(host).host;
}

export interface HostSources {
    flag?: string | null;
    env?: string | null;
    glabDefault?: () => string | null;
}

export const HOST_HELP = [
    "No GitLab host configured. Use any one of these:",
    "   --host https://gitlab.example.com",
    "   export GITLAB_HOST=https://gitlab.example.com",
    "   glab auth login --hostname gitlab.example.com   # glab's default host is used from then on",
].join("\n");

export function pickHost(sources: HostSources): { host: string; source: string } {
    if (sources.flag?.trim()) {
        return { host: normalizeHost(sources.flag), source: "--host" };
    }

    if (sources.env?.trim()) {
        return { host: normalizeHost(sources.env), source: "GITLAB_HOST" };
    }

    const fromGlab = sources.glabDefault?.();
    if (fromGlab?.trim()) {
        return { host: normalizeHost(fromGlab), source: "glab config get host" };
    }

    throw new Error(HOST_HELP);
}

interface RunResult {
    installed: boolean;
    exitCode: number;
    out: string;
}

function runText(cmd: string[]): RunResult {
    if (Bun.which(cmd[0] ?? "") === null) {
        return { installed: false, exitCode: 127, out: "" };
    }

    try {
        const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });

        return { installed: true, exitCode: result.exitCode ?? 1, out: result.stdout.toString().trim() };
    } catch (error) {
        logger.debug({ error, cmd: cmd.join(" ") }, "gitlab: spawn failed");

        return { installed: false, exitCode: 127, out: "" };
    }
}

function glabDefaultHost(): string | null {
    const result = runText(["glab", "config", "get", "host"]);

    return result.exitCode === 0 && result.out ? result.out : null;
}

export function resolveHost(flag?: string | null): string {
    const { host, source } = pickHost({ flag, env: env.getTrimmed("GITLAB_HOST"), glabDefault: glabDefaultHost });
    logger.debug({ host, source }, "gitlab: host resolved");

    return host;
}

// ─── token ─────────────────────────────────────────────────────────────────────

/** `api` alone covers everything here: reading discussions and writing notes, drafts and labels. */
const TOKEN_SCOPES = "api";

export function newTokenUrl(host: string): string {
    return `${host}/-/user_settings/personal_access_tokens?name=genesis-tools&scopes=${TOKEN_SCOPES}`;
}

/** Printed when nothing yields a token, so the next step is a click and a paste. */
export function tokenSetupHelp(host: string, tried: string[]): string {
    const hostname = hostnameOf(host);

    return [
        `No GitLab token found for ${hostname}.`,
        "",
        `1. Create one, scopes already filled in (${TOKEN_SCOPES}):`,
        `   ${newTokenUrl(host)}`,
        "",
        "2. Store it, any one of these:",
        ...(
            [
                [`glab auth login --hostname ${hostname}`, "glab keeps it, nothing else to do"],
                ["export GITLAB_TOKEN=<token>", "this shell only"],
            ] as const
        ).map(([command, note]) => `   ${command.padEnd(46)} # ${note}`),
        "",
        "Looked in:",
        ...tried.map((line) => `   ${line}`),
    ].join("\n");
}

/**
 * A token is one word. `glab auth token` prints its help text and still exits 0 when the
 * subcommand does not exist in the installed version, so the shape is checked, not the exit code.
 */
export function looksLikeToken(text: string): boolean {
    const token = text.trim();

    return token.length >= 20 && !/\s/.test(token);
}

function tokenCommands(hostname: string): string[][] {
    return [
        ["glab", "config", "get", "token", "--host", hostname],
        ["glab", "auth", "token", "--hostname", hostname],
    ];
}

/** Resolved once per host per process: every command fires several requests, and each miss costs a subprocess. */
const tokenCache = new Map<string, string>();

export async function getToken(host: string): Promise<string> {
    const fromEnv = env.getTrimmed("GITLAB_TOKEN");
    if (fromEnv) {
        return fromEnv;
    }

    const hostname = hostnameOf(host);
    const cached = tokenCache.get(hostname);
    if (cached) {
        return cached;
    }

    const tried = ["GITLAB_TOKEN env — unset"];

    for (const cmd of tokenCommands(hostname)) {
        const label = cmd.join(" ");
        const result = runText(cmd);

        if (looksLikeToken(result.out)) {
            tokenCache.set(hostname, result.out);
            logger.debug({ hostname, source: label.replace(/ --host.*$/, "") }, "gitlab: token resolved");

            return result.out;
        }

        if (!result.installed) {
            tried.push(`${label} — not installed`);
        } else {
            tried.push(`${label} — ${result.out ? "no token in the output" : `empty (exit ${result.exitCode})`}`);
        }
    }

    throw new Error(tokenSetupHelp(host, tried));
}

/** Drops the memoised tokens; for tests and for a caller that just re-authenticated. */
export function clearTokenCache(): void {
    tokenCache.clear();
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The token goes out as `PRIVATE-TOKEN` or a bearer header on every request, so a plain `http://`
 * host would send it across the network in clear text. Loopback stays allowed for local servers.
 */
export function assertSecureHost(host: string): void {
    const url = new URL(host);

    if (url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) {
        throw new Error(`Refusing to send a GitLab token over ${url.protocol} to ${url.hostname}; use https://.`);
    }
}

export async function resolveApi(options: { host?: string | null } = {}): Promise<GitLabApi> {
    const host = resolveHost(options.host);
    assertSecureHost(host);

    return { host, token: await getToken(host) };
}

// ─── project ───────────────────────────────────────────────────────────────────

/** Host and `namespace/project` from the common GitLab remote URL shapes. */
export function parseGitLabRemote(url: string): { hostname: string; path: string } | null {
    const trimmed = url.trim();
    if (!trimmed) {
        return null;
    }

    const scp = trimmed.match(/^[^@/]+@([^:/]+):(?!\/)(.+)$/);
    if (scp) {
        return { hostname: scp[1] ?? "", path: (scp[2] ?? "").replace(/\.git$/, "").replace(/\/+$/, "") };
    }

    try {
        const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
        const path = parsed.pathname
            .replace(/^\/+/, "")
            .replace(/\.git$/, "")
            .replace(/\/+$/, "");

        return path ? { hostname: parsed.hostname, path } : null;
    } catch (error) {
        logger.debug({ error, url }, "gitlab: unparsable remote URL");

        return null;
    }
}

export function parseGitLabProjectFromRemote(url: string): string | null {
    return parseGitLabRemote(url)?.path ?? null;
}

export interface ProjectSources {
    flag?: string | null;
    env?: string | null;
    /** URL of the `origin` remote of the current checkout. */
    remote?: string | null;
    host: string;
}

export function pickProject(sources: ProjectSources): { project: string; source: string } {
    if (sources.flag?.trim()) {
        return { project: sources.flag.trim(), source: "--project" };
    }

    if (sources.env?.trim()) {
        return { project: sources.env.trim(), source: "GITLAB_PROJECT" };
    }

    const wanted = new URL(sources.host).hostname;
    const remote = sources.remote ? parseGitLabRemote(sources.remote) : null;
    if (remote && remote.hostname === wanted) {
        return { project: remote.path, source: "git remote origin" };
    }

    const why = remote ? ` The origin remote points at ${remote.hostname}, not ${wanted}.` : "";

    throw new Error(
        `No GitLab project.${why} Pass --project <group/name or numeric id>, export GITLAB_PROJECT=<group/name>, or run inside a checkout whose origin is on ${wanted}.`
    );
}

export function originRemote(cwd: string = process.cwd()): string | null {
    const result = gitResult(gitRepoRoot(cwd), ["remote", "get-url", "origin"]);

    return result.exitCode === 0 && result.stdout ? result.stdout : null;
}

export async function resolveProjectApi(
    options: { host?: string | null; project?: string | null; cwd?: string } = {}
): Promise<ProjectApi> {
    const api = await resolveApi({ host: options.host });
    const fromEnv = env.getTrimmed("GITLAB_PROJECT");
    const { project, source } = pickProject({
        flag: options.project,
        env: fromEnv,
        remote: options.project?.trim() || fromEnv ? null : originRemote(options.cwd),
        host: api.host,
    });
    logger.debug({ project, source }, "gitlab: project resolved");

    return { ...api, project };
}

/** `/projects/<url-encoded path or id>`, the prefix of every project-scoped endpoint. */
export function projectBase(api: ProjectApi): string {
    return `/projects/${encodeURIComponent(api.project)}`;
}

// ─── transport ─────────────────────────────────────────────────────────────────

export interface RestOptions {
    timeout?: number;
    /** Total attempts including the first. */
    retries?: number;
}

function apiUrl(api: GitLabApi, path: string): string {
    return `${api.host}/api/v4${path}`;
}

async function send(
    api: GitLabApi,
    request: { method: string; path: string; body?: unknown; timeout: number }
): Promise<Response> {
    const url = apiUrl(api, request.path);
    logger.debug({ method: request.method, url }, "gitlab: request");

    const res = await fetch(url, {
        method: request.method,
        headers: {
            "PRIVATE-TOKEN": api.token,
            ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: request.body === undefined ? undefined : SafeJSON.stringify(request.body),
        signal: AbortSignal.timeout(request.timeout),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new HttpError({ status: res.status, statusText: res.statusText, url, body });
    }

    return res;
}

/** Every GitLab response body goes through the same strict SafeJSON parse `restWrite` uses. */
async function parseBody<T>(res: Response): Promise<T> {
    return SafeJSON.parse(await res.text(), { strict: true }) as T;
}

function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
    return retry(fn, { maxAttempts: attempts, delay: 250, backoff: "exponential", shouldRetry: isRetryableError });
}

/** GET with retries on 408/429/5xx and transport failures; everything else fails fast. */
export async function restGet<T>(api: GitLabApi, path: string, opts: RestOptions = {}): Promise<T> {
    return withRetry(async () => {
        const res = await send(api, { method: "GET", path, timeout: opts.timeout ?? 30_000 });

        return parseBody<T>(res);
    }, opts.retries ?? 3);
}

/** GET of a raw body, for endpoints such as `repository/files/:path/raw`. */
export async function restGetText(api: GitLabApi, path: string, opts: RestOptions = {}): Promise<string> {
    return withRetry(async () => {
        const res = await send(api, { method: "GET", path, timeout: opts.timeout ?? 30_000 });

        return res.text();
    }, opts.retries ?? 3);
}

/**
 * POST/PUT/DELETE through the same retry policy as `restGet`. A 400 from a rejected write fails
 * fast and keeps its body, which is where GitLab puts the reason. `T` is `void` for a 204.
 *
 * 🛑 A POST is sent ONCE unless the caller opts in. GitLab can commit a POST and still answer
 * 502, or commit it after the client timeout fired, and a retry then created a second note or
 * a second draft. The ledger cannot dedupe that: it is written after the call returns.
 */
export async function restWrite<T>(
    api: GitLabApi,
    request: { method: "POST" | "PUT" | "DELETE"; path: string; body?: unknown } & RestOptions
): Promise<T> {
    return withRetry(
        async () => {
            const res = await send(api, { ...request, timeout: request.timeout ?? 15_000 });

            if (res.status === 204) {
                return undefined as T;
            }

            const text = await res.text();

            return (text ? SafeJSON.parse(text, { strict: true }) : undefined) as T;
        },
        request.retries ?? (request.method === "POST" ? 1 : 3)
    );
}

/** One GET page plus its parsed `X-Next-Page`, with the same retry policy as `restGet`. */
export async function restGetPage<T>(api: GitLabApi, path: string, opts: RestOptions = {}): Promise<Page<T>> {
    return withRetry(async () => {
        const res = await send(api, { method: "GET", path, timeout: opts.timeout ?? 30_000 });

        return { items: await parseBody<T[]>(res), nextPage: parseNextPage(res.headers.get("x-next-page")) };
    }, opts.retries ?? 3);
}

/**
 * Every page of a GET. The path carries every query parameter except `page` and `per_page`
 * (forced to 100). The page walk and its stop rules live in `paginate.ts`.
 */
export async function restGetPaginated<T>(api: GitLabApi, path: string, opts: RestOptions = {}): Promise<T[]> {
    const sep = path.includes("?") ? "&" : "?";
    const { items, truncated, pages } = await fetchAllPages<T>(
        (page) => restGetPage<T>(api, `${path}${sep}per_page=100&page=${page}`, opts),
        { maxPages: 500, perPage: 100 }
    );

    if (truncated) {
        logger.warn({ path, pages }, `gitlab: ${path}: stopped after ${pages} pages of 100; later pages were NOT read`);
    }

    return items;
}

export async function graphql<T>(api: GitLabApi, query: string, variables?: Record<string, unknown>): Promise<T> {
    const url = `${api.host}/api/graphql`;
    logger.debug({ url }, "gitlab: graphql");

    const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json" },
        body: SafeJSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new HttpError({ status: res.status, statusText: res.statusText, url, body: text });
    }

    const body = await parseBody<{ data?: T; errors?: Array<{ message: string }> }>(res);
    if (body.errors?.length) {
        throw new Error(`GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
    }

    return body.data as T;
}

// ─── high-level helpers ────────────────────────────────────────────────────────

export interface GitLabUser {
    id: number;
    username: string;
    name: string;
    web_url: string;
    state?: string;
}

export interface GitLabProject {
    id: number;
    name: string;
    name_with_namespace: string;
    path_with_namespace: string;
    web_url: string;
    default_branch: string;
}

export interface GitLabCommit {
    id: string;
    short_id: string;
    title: string;
    message: string;
    author_name: string;
    author_email: string;
    authored_date: string;
    committed_date: string;
    web_url: string;
    stats?: { additions: number; deletions: number; total: number };
}

export interface GitLabDiff {
    old_path: string;
    new_path: string;
    new_file: boolean;
    renamed_file: boolean;
    deleted_file: boolean;
}

export interface GitLabPushData {
    commit_count: number;
    action: string;
    ref_type: string;
    ref: string;
    commit_from: string | null;
    commit_to: string | null;
    commit_title: string | null;
}

export interface GitLabEvent {
    id: number;
    project_id: number;
    action_name: string;
    target_type: string | null;
    created_at: string;
    push_data?: GitLabPushData;
}

export interface GitLabBranch {
    name: string;
    commit: { id: string };
    default: boolean;
    merged: boolean;
    protected?: boolean;
}

/** The owner of the token. */
export async function currentUser(api: GitLabApi): Promise<GitLabUser> {
    return restGet<GitLabUser>(api, "/user");
}

export async function findUser(api: GitLabApi, username: string): Promise<GitLabUser | null> {
    const users = await restGet<GitLabUser[]>(api, `/users?username=${encodeURIComponent(username)}`);

    return users[0] ?? null;
}

/** All projects a user has pushed to or contributed activity on. */
export async function getContributedProjects(api: GitLabApi, userId: number): Promise<GitLabProject[]> {
    return restGetPaginated<GitLabProject>(api, `/users/${userId}/contributed_projects`);
}

/**
 * One commit with optional stats.
 *
 * Do not page `?author=` together with `?all=true` instead: on GitLab 18.x that combination
 * returns the same page for every `?page=N`, so pagination silently stops at 100 rows. Use
 * `getUserEvents` plus `compareCommits`.
 */
export async function getCommit(
    api: GitLabApi,
    commit: { projectId: number; sha: string; withStats?: boolean }
): Promise<GitLabCommit> {
    const stats = commit.withStats === false ? "" : "?stats=true";

    return restGet<GitLabCommit>(api, `/projects/${commit.projectId}/repository/commits/${commit.sha}${stats}`);
}

/** Every page: a single `per_page=100` request cut a commit touching more files at the first 100. */
export async function getCommitDiff(api: GitLabApi, projectId: number, sha: string): Promise<GitLabDiff[]> {
    return restGetPaginated<GitLabDiff>(api, `/projects/${projectId}/repository/commits/${sha}/diff`);
}

/** Every event of a user after `sinceDate`; paginates reliably, unlike `repository/commits?all=true`. */
export async function getUserEvents(api: GitLabApi, userId: number, sinceDate: string): Promise<GitLabEvent[]> {
    return restGetPaginated<GitLabEvent>(api, `/users/${userId}/events?after=${encodeURIComponent(sinceDate)}`);
}

/** Commits between two SHAs, exclusive of `from` and inclusive of `to`. */
export async function compareCommits(
    api: GitLabApi,
    range: { projectId: number; from: string; to: string }
): Promise<GitLabCommit[]> {
    const body = await restGet<{ commits: GitLabCommit[] }>(
        api,
        `/projects/${range.projectId}/repository/compare?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
    );

    return body.commits ?? [];
}

/** A project by numeric id or by `namespace/path`. */
export async function getProject(api: GitLabApi, idOrPath: number | string): Promise<GitLabProject> {
    return restGet<GitLabProject>(api, `/projects/${encodeURIComponent(String(idOrPath))}`);
}

export async function getBranches(api: GitLabApi, projectId: number): Promise<GitLabBranch[]> {
    return restGetPaginated<GitLabBranch>(api, `/projects/${projectId}/repository/branches`);
}

/**
 * Every commit reachable from any branch within a date window, with stats: each branch is walked
 * with `?ref_name=…&since=…&with_stats=true` (which paginates reliably) and deduplicated by SHA.
 */
export async function getProjectCommitsInRange(
    api: GitLabApi,
    range: { projectId: number; sinceIso: string; untilIso: string | null; concurrency?: number }
): Promise<GitLabCommit[]> {
    const branches = await getBranches(api, range.projectId);
    const dedup = new Map<string, GitLabCommit>();

    await pool(branches, range.concurrency ?? 6, async (branch) => {
        let path = `/projects/${range.projectId}/repository/commits?ref_name=${encodeURIComponent(branch.name)}&since=${encodeURIComponent(range.sinceIso)}&with_stats=true`;
        if (range.untilIso) {
            path += `&until=${encodeURIComponent(range.untilIso)}`;
        }

        for (const commit of await restGetPaginated<GitLabCommit>(api, path)) {
            if (!dedup.has(commit.id)) {
                dedup.set(commit.id, commit);
            }
        }
    });

    return [...dedup.values()];
}
