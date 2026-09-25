import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyOriginUrl } from "./detector";
import { toState as ghState } from "./gh";
import { toState as glabState } from "./glab";
import { spawnRunner } from "./runner";
import type { CommandRunner, OriginKind, PrState } from "./types";
import { originWebBase } from "./web";

/**
 * Read-only listing and viewing of PRs (GitHub, via `gh`) and MRs (GitLab, via `glab api`) for a
 * project. Every call is a list/view/GET; nothing here posts, approves or merges.
 */

export type PrListState = "open" | "merged" | "all";
export const PR_LIST_STATES: readonly PrListState[] = ["open", "merged", "all"];

/** One CI word for both hosts: the rollup of GitHub checks, or the GitLab pipeline status. */
export type CiStatus = "success" | "failed" | "running" | "pending";
export type CheckStatus = CiStatus | "skipped";
/** Conflict state only; the host's full merge gate (blocked, behind, draft…) is in `mergeStatus`. */
export type Mergeable = "mergeable" | "conflicting" | "unknown";

/** A hosted project: `path` is `owner/repo` on GitHub, `group/sub/project` on GitLab. */
export interface ProjectRef {
    kind: OriginKind;
    /** Host as the CLIs want it (`--hostname`), an http port included. */
    host: string;
    path: string;
    /** `https://host/path`. */
    web: string;
}

export interface PrSummary {
    number: number;
    title: string;
    state: PrState;
    draft: boolean;
    author: string | null;
    headBranch: string;
    baseBranch: string;
    url: string;
    createdAt: string;
    updatedAt: string;
    labels: string[];
    /** Requested reviewers (GitHub) or assigned reviewers (GitLab). */
    reviewers: string[];
    /** GitHub's APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED; GitLab only in a detail view. */
    reviewDecision: string | null;
    /** Distinct approvers; null when the host does not return it in this call. */
    approvals: number | null;
    ci: CiStatus | null;
    /** Discussion comments; null when the host does not return a count in this call. */
    comments: number | null;
    headSha: string | null;
    /** The head branch lives in another project (a fork). */
    crossRepository: boolean;
    /** That project's path (`owner/repo`) on the same host; null for a same-project PR or when the host did not say. */
    headRepo: string | null;
}

export interface PrCommit {
    sha: string;
    title: string;
    /** The host login when the commit is linked to an account, else the git author name. */
    author: string | null;
    /** The host login alone (a profile page exists); null for an unlinked author and for GitLab, whose commits carry names only. */
    authorLogin: string | null;
    date: string | null;
    /** The message below the title line, trimmed; null when the commit has none. */
    body: string | null;
}

export interface PrCheck {
    name: string;
    status: CheckStatus | null;
    url: string | null;
}

export interface PrDetail extends PrSummary {
    body: string;
    commits: PrCommit[];
    changedFiles: number | null;
    additions: number | null;
    deletions: number | null;
    baseSha: string | null;
    mergeable: Mergeable | null;
    /** The host's raw merge gate: gh `mergeStateStatus`, GitLab `detailed_merge_status`. */
    mergeStatus: string | null;
    checks: PrCheck[];
    webUrls: { pr: string; files: string; commits: string; checks: string };
}

/** `error` set means the host could not answer; an empty `prs` with `error` null means "no PRs". */
export interface PrListResult {
    prs: PrSummary[];
    error: string | null;
    /** Secondary lookups that failed (e.g. GitLab pipelines): the PRs are real, a field is null. */
    warnings: string[];
}

export interface PrViewResult {
    pr: PrDetail | null;
    error: string | null;
    warnings: string[];
}

const PR_QUERY_TIMEOUT_MS = 30_000;
const GLAB_MAX_PER_PAGE = 100;
/** GraphQL's page ceiling for one connection. */
const GH_MAX_PAGE = 100;
/** How many GraphQL pages one date range may walk before it stops with a warning. */
const GH_MAX_UPDATED_PAGES = 10;

const log = logger.child({ component: "origins/prs" });

class PrParseError extends Error {}

function parseJson(json: string, what: string): unknown {
    try {
        return SafeJSON.parse(json, { strict: true });
    } catch (err) {
        log.debug({ err, what }, "unparsable host output");
        throw new PrParseError(`unparsable ${what} output`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter(isRecord) : [];
}

function str(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function login(value: unknown, key = "login"): string | null {
    return isRecord(value) ? str(value[key]) : null;
}

// ---------------------------------------------------------------------------
// Project references
// ---------------------------------------------------------------------------

/** The hosted project behind a git remote URL; null for hosts without a driver or a URL without a path. */
export function projectRefFromRemote(remoteUrl: string): ProjectRef | null {
    const { kind } = classifyOriginUrl(remoteUrl);
    const web = originWebBase(remoteUrl);

    if (!kind || !web) {
        return null;
    }

    const parsed = new URL(web);
    return { kind, host: parsed.host, path: parsed.pathname.replace(/^\/+/, ""), web };
}

/**
 * A PR/MR web URL split into project and number: `https://github.com/o/r/pull/12`,
 * `https://gitlab.host/g/sub/p/-/merge_requests/9` (a trailing tab like `/diffs` is allowed).
 */
export function parsePrUrl(url: string): { project: ProjectRef; number: number } | null {
    let parsed: URL;

    try {
        parsed = new URL(url.trim());
    } catch (err) {
        log.debug({ err, url }, "not a PR URL");
        return null;
    }

    const { kind } = classifyOriginUrl(parsed.href);
    const match =
        kind === "github"
            ? /^\/(.+?)\/pull\/(\d+)(?:\/.*)?$/.exec(parsed.pathname)
            : kind === "gitlab"
              ? /^\/(.+?)\/(?:-\/)?merge_requests\/(\d+)(?:\/.*)?$/.exec(parsed.pathname)
              : null;

    if (!kind || !match) {
        return null;
    }

    const host = parsed.protocol.startsWith("http") ? parsed.host : parsed.hostname;
    const path = match[1];
    return {
        project: { kind, host: host.toLowerCase(), path, web: `https://${host.toLowerCase()}/${path}` },
        number: Number(match[2]),
    };
}

function webUrls(kind: OriginKind, url: string): PrDetail["webUrls"] {
    return kind === "github"
        ? { pr: url, files: `${url}/files`, commits: `${url}/commits`, checks: `${url}/checks` }
        : { pr: url, files: `${url}/diffs`, commits: `${url}/commits`, checks: `${url}/pipelines` };
}

// ---------------------------------------------------------------------------
// CI vocabularies
// ---------------------------------------------------------------------------

const GH_FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const GH_SKIPPED = new Set(["SKIPPED", "NEUTRAL", "STALE"]);

/** One GitHub rollup entry: a CheckRun (`status` + `conclusion`) or a StatusContext (`state`). */
export function ghCheckStatus(entry: Record<string, unknown>): CheckStatus | null {
    const state = str(entry.state)?.toUpperCase();

    if (state) {
        if (state === "SUCCESS") {
            return "success";
        }

        return GH_FAILED.has(state) ? "failed" : "pending";
    }

    const status = str(entry.status)?.toUpperCase();

    if (status === "IN_PROGRESS") {
        return "running";
    }

    if (status && status !== "COMPLETED") {
        return "pending";
    }

    const conclusion = str(entry.conclusion)?.toUpperCase();

    if (!conclusion) {
        return null;
    }

    if (conclusion === "SUCCESS") {
        return "success";
    }

    if (GH_SKIPPED.has(conclusion)) {
        return "skipped";
    }

    return GH_FAILED.has(conclusion) ? "failed" : null;
}

/** Worst wins: failed, then running, then pending, then success. Only skipped checks count as success. */
export function rollupCi(statuses: (CheckStatus | null)[]): CiStatus | null {
    const known = statuses.filter((s): s is CheckStatus => s !== null);

    if (known.length === 0) {
        return null;
    }

    for (const worst of ["failed", "running", "pending"] as const) {
        if (known.includes(worst)) {
            return worst;
        }
    }

    return "success";
}

/** GitLab pipeline status (`created`, `manual`, `canceled`, …) onto the shared words. */
export function glabPipelineStatus(raw: unknown): CheckStatus | null {
    switch (str(raw)?.toLowerCase()) {
        case undefined:
            return null;
        case "success":
            return "success";
        case "failed":
        case "canceled":
        case "canceling":
            return "failed";
        case "running":
            return "running";
        case "skipped":
            return "skipped";
        default:
            return "pending";
    }
}

function toCi(status: CheckStatus | null): CiStatus | null {
    return status === "skipped" ? "success" : status;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export const GH_LIST_FIELDS = [
    "number",
    "title",
    "state",
    "isDraft",
    "author",
    "headRefName",
    "baseRefName",
    "headRefOid",
    "isCrossRepository",
    "headRepository",
    "headRepositoryOwner",
    "url",
    "createdAt",
    "updatedAt",
    "labels",
    "reviewDecision",
    "reviewRequests",
    "latestReviews",
    "statusCheckRollup",
];

export const GH_VIEW_FIELDS = [
    ...GH_LIST_FIELDS,
    "body",
    "comments",
    "commits",
    "changedFiles",
    "additions",
    "deletions",
    "baseRefOid",
    "mergeable",
    "mergeStateStatus",
];

function ghSummary(row: Record<string, unknown>): PrSummary | null {
    const number = num(row.number);
    const url = str(row.url);

    if (number === null || !url) {
        return null;
    }

    const approvers = new Set(
        records(row.latestReviews)
            .filter((review) => str(review.state) === "APPROVED")
            .map((review) => login(review.author))
            .filter((name): name is string => name !== null)
    );

    return {
        number,
        title: str(row.title) ?? "",
        state: ghState(str(row.state) ?? ""),
        draft: row.isDraft === true,
        author: login(row.author),
        headBranch: str(row.headRefName) ?? "",
        baseBranch: str(row.baseRefName) ?? "",
        url,
        createdAt: str(row.createdAt) ?? "",
        updatedAt: str(row.updatedAt) ?? "",
        labels: records(row.labels)
            .map((label) => str(label.name))
            .filter((name): name is string => name !== null),
        reviewers: records(row.reviewRequests)
            .map((request) => str(request.login) ?? str(request.slug) ?? str(request.name))
            .filter((name): name is string => name !== null),
        reviewDecision: str(row.reviewDecision) || null,
        approvals: Array.isArray(row.latestReviews) ? approvers.size : null,
        ci: rollupCi(records(row.statusCheckRollup).map(ghCheckStatus)),
        comments: Array.isArray(row.comments) ? row.comments.length : null,
        headSha: str(row.headRefOid),
        crossRepository: row.isCrossRepository === true,
        headRepo: row.isCrossRepository === true ? ghHeadRepo(row) : null,
    };
}

function ghHeadRepo(row: Record<string, unknown>): string | null {
    const owner = login(row.headRepositoryOwner);
    const name = isRecord(row.headRepository) ? str(row.headRepository.name) : null;
    return owner && name ? `${owner}/${name}` : null;
}

/** Pure mapping of `gh pr list --json <GH_LIST_FIELDS>`; throws on output it cannot read. */
export function parseGhPrRows(json: string): PrSummary[] {
    const rows = parseJson(json, "gh");

    if (!Array.isArray(rows)) {
        throw new PrParseError("gh output is not a list");
    }

    return records(rows)
        .map(ghSummary)
        .filter((pr): pr is PrSummary => pr !== null);
}

/**
 * One page of a repository's PRs, most recently updated first. `gh pr list` orders by creation, and
 * its `--search` form needs GitHub's search index, which holds no PRs of some repositories (a fork
 * answered `[]` even to `is:pr`), so a date range asks GraphQL for the update order directly. The
 * fields are the ones `gh pr list --json <GH_LIST_FIELDS>` returns, so one parser reads both. CI is
 * the rollup's own state, not each check: with every check of 100 PRs one page took about 7 s.
 */
export function ghUpdatedQuery(state: PrListState, first: number): string {
    const states = state === "open" ? ", states: [OPEN]" : state === "merged" ? ", states: [MERGED]" : "";
    return `query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: ${first}${states}, orderBy: {field: UPDATED_AT, direction: DESC}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state isDraft url createdAt updatedAt reviewDecision
        author { login }
        headRefName baseRefName headRefOid isCrossRepository
        headRepository { name }
        headRepositoryOwner { login }
        labels(first: 20) { nodes { name } }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { slug name } } } }
        latestReviews(first: 20) { nodes { state author { login } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;
}

function graphNodes(value: unknown): Record<string, unknown>[] {
    return isRecord(value) ? records(value.nodes) : [];
}

/** Pure mapping of `ghUpdatedQuery`'s answer onto the `gh pr list --json` rows; throws on output it cannot read. */
export function parseGhUpdatedPrs(json: string): PrSummary[] {
    return parseGhUpdatedPage(json).prs;
}

/** One page of `ghUpdatedQuery`'s answer: its PRs, and the cursor of the next page when the host has one. */
function parseGhUpdatedPage(json: string): { prs: PrSummary[]; next: string | null } {
    const root = parseJson(json, "gh graphql");
    const errors = isRecord(root) ? records(root.errors).map((error) => str(error.message) ?? "error") : [];
    const data = isRecord(root) && isRecord(root.data) ? root.data : null;
    const repository = data && isRecord(data.repository) ? data.repository : null;

    if (!repository) {
        throw new PrParseError(errors.join("; ") || "gh graphql returned no repository");
    }

    const connection = isRecord(repository.pullRequests) ? repository.pullRequests : null;
    const pageInfo = connection && isRecord(connection.pageInfo) ? connection.pageInfo : null;
    const next = pageInfo?.hasNextPage === true ? str(pageInfo.endCursor) : null;
    const prs = graphNodes(connection)
        .map((node) => {
            const commit = graphNodes(node.commits)[0]?.commit;
            const rollup = isRecord(commit) && isRecord(commit.statusCheckRollup) ? commit.statusCheckRollup : null;
            return ghSummary({
                ...node,
                labels: graphNodes(node.labels),
                reviewRequests: graphNodes(node.reviewRequests).map((request) =>
                    isRecord(request.requestedReviewer) ? request.requestedReviewer : {}
                ),
                latestReviews: graphNodes(node.latestReviews),
                // One entry with the rollup's state: SUCCESS, FAILURE / ERROR, PENDING / EXPECTED.
                statusCheckRollup: rollup ? [{ state: rollup.state }] : [],
            });
        })
        .filter((pr): pr is PrSummary => pr !== null);
    return { prs, next };
}

/**
 * `listPrs` with `updatedSince` on GitHub: GraphQL pages in update order, walked until a page reaches
 * a PR older than `updatedSince`, the host has no more, or `limit` PRs matched. `mine` filters on
 * the client, after the page cut, so it reads full pages: a limit-sized page of other authors' PRs
 * would hide the viewer's.
 */
async function listGhUpdatedSince({
    project,
    state,
    mine,
    limit,
    updatedSince,
    cwd,
    runner,
}: {
    project: ProjectRef;
    state: PrListState;
    mine: boolean;
    limit: number;
    updatedSince: Date;
    cwd: string;
    runner: CommandRunner;
}): Promise<PrListResult> {
    const warnings: string[] = [];
    const [owner, ...rest] = project.path.split("/");
    const wanted = Math.max(limit, 1);
    const first = mine ? GH_MAX_PAGE : Math.min(wanted, GH_MAX_PAGE);
    const viewer = mine ? await viewerLogin({ project, cwd, runner }) : null;

    if (mine && !viewer) {
        warnings.push("mine: the logged-in user is unknown, so every author is listed");
    }

    const prs: PrSummary[] = [];
    let after: string | null = null;
    let pages = 0;

    for (;;) {
        const cmd = [
            "gh",
            "api",
            "graphql",
            "--hostname",
            project.host,
            "-f",
            `query=${ghUpdatedQuery(state, first)}`,
            // -f, not -F: -F would turn a numeric repository name into a number.
            "-f",
            `owner=${owner}`,
            "-f",
            `repo=${rest.join("/")}`,
            ...(after ? ["-f", `after=${after}`] : []),
        ];
        const res = await run({ cmd, cwd, runner });

        if (res.error) {
            return { prs: [], error: res.error, warnings };
        }

        const page = parseGhUpdatedPage(res.stdout);
        const inRange = page.prs.filter((pr) => Date.parse(pr.updatedAt) >= updatedSince.getTime());
        prs.push(...inRange.filter((pr) => !viewer || pr.author === viewer));
        pages += 1;

        if (inRange.length < page.prs.length || !page.next || prs.length >= wanted) {
            break;
        }

        if (pages >= GH_MAX_UPDATED_PAGES) {
            warnings.push(`stopped after ${pages * first} PRs; older PRs in the range may be missing`);
            break;
        }

        after = page.next;
    }

    log.debug(
        { project: project.path, state, mine, updatedSince, pages, count: prs.length },
        "gh graphql prs updated since"
    );
    return { prs: prs.slice(0, limit), error: null, warnings };
}

function ghMergeable(raw: string | null): Mergeable | null {
    switch (raw) {
        case "MERGEABLE":
            return "mergeable";
        case "CONFLICTING":
            return "conflicting";
        case "UNKNOWN":
            return "unknown";
        default:
            return null;
    }
}

/** Pure mapping of `gh pr view --json <GH_VIEW_FIELDS>`. */
export function parseGhPrView(json: string): PrDetail {
    const row = parseJson(json, "gh");
    const summary = isRecord(row) ? ghSummary(row) : null;

    if (!isRecord(row) || !summary) {
        throw new PrParseError("gh returned no PR with number and url");
    }

    return {
        ...summary,
        body: str(row.body) ?? "",
        commits: records(row.commits).map((commit) => {
            const [firstAuthor] = records(commit.authors);
            return {
                sha: str(commit.oid) ?? "",
                title: str(commit.messageHeadline) ?? "",
                author: firstAuthor ? (str(firstAuthor.login) ?? str(firstAuthor.name)) : null,
                authorLogin: firstAuthor ? str(firstAuthor.login) : null,
                date: str(commit.committedDate) ?? str(commit.authoredDate),
                body: str(commit.messageBody)?.trim() || null,
            };
        }),
        changedFiles: num(row.changedFiles),
        additions: num(row.additions),
        deletions: num(row.deletions),
        baseSha: str(row.baseRefOid),
        mergeable: ghMergeable(str(row.mergeable)),
        mergeStatus: str(row.mergeStateStatus),
        checks: records(row.statusCheckRollup).map((check) => {
            const name = str(check.name) ?? str(check.context) ?? "check";
            const workflow = str(check.workflowName);
            return {
                name: workflow ? `${workflow} / ${name}` : name,
                status: ghCheckStatus(check),
                url: str(check.detailsUrl) ?? str(check.targetUrl),
            };
        }),
        webUrls: webUrls("github", summary.url),
    };
}

function ghRepoArg(project: ProjectRef): string {
    return `${project.host}/${project.path}`;
}

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

function glabLabels(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((label) => (typeof label === "string" ? label : isRecord(label) ? str(label.name) : null))
        .filter((name): name is string => name !== null);
}

function glabSummary(row: Record<string, unknown>, ciBySha: Map<string, CheckStatus | null>): PrSummary | null {
    const number = num(row.iid);
    const url = str(row.web_url);

    if (number === null || !url) {
        return null;
    }

    const headSha = str(row.sha);
    const sourceProject = num(row.source_project_id);
    const targetProject = num(row.target_project_id);
    const headPipeline = isRecord(row.head_pipeline) ? row.head_pipeline : null;
    const ci = headPipeline ? glabPipelineStatus(headPipeline.status) : headSha ? (ciBySha.get(headSha) ?? null) : null;

    return {
        number,
        title: str(row.title) ?? "",
        state: glabState(str(row.state) ?? ""),
        draft: row.draft === true || row.work_in_progress === true,
        author: login(row.author, "username"),
        headBranch: str(row.source_branch) ?? "",
        baseBranch: str(row.target_branch) ?? "",
        url,
        createdAt: str(row.created_at) ?? "",
        updatedAt: str(row.updated_at) ?? "",
        labels: glabLabels(row.labels),
        reviewers: records(row.reviewers)
            .map((reviewer) => str(reviewer.username))
            .filter((name): name is string => name !== null),
        reviewDecision: null,
        approvals: null,
        ci: toCi(ci),
        comments: num(row.user_notes_count),
        headSha,
        crossRepository: sourceProject !== null && targetProject !== null && sourceProject !== targetProject,
        // The MR row names the source project by id only; its path would cost another call.
        headRepo: null,
    };
}

/** Newest pipeline per sha (the API lists newest first), for joining MRs to CI in one extra call. */
export function glabPipelinesBySha(json: string): Map<string, CheckStatus | null> {
    const rows = parseJson(json, "glab pipelines");
    const bySha = new Map<string, CheckStatus | null>();

    for (const row of records(rows)) {
        const sha = str(row.sha);

        if (sha && !bySha.has(sha)) {
            bySha.set(sha, glabPipelineStatus(row.status));
        }
    }

    return bySha;
}

/** Pure mapping of `GET projects/:id/merge_requests`; CI comes from `ciBySha` (the list has no pipeline). */
export function parseGlabMrRows(json: string, ciBySha: Map<string, CheckStatus | null> = new Map()): PrSummary[] {
    const rows = parseJson(json, "glab");

    if (!Array.isArray(rows)) {
        throw new PrParseError("glab output is not a list");
    }

    return records(rows)
        .map((row) => glabSummary(row, ciBySha))
        .filter((pr): pr is PrSummary => pr !== null);
}

function glabMergeable(row: Record<string, unknown>): Mergeable | null {
    if (row.has_conflicts === true) {
        return "conflicting";
    }

    const status = str(row.detailed_merge_status) ?? str(row.merge_status);

    if (!status) {
        return null;
    }

    return status === "checking" || status === "unchecked" || status === "preparing" ? "unknown" : "mergeable";
}

/** GitLab's `message` repeats the title as its first line; the body is what follows it. */
function glabCommitBody(message: string | null): string | null {
    const newline = message?.indexOf("\n") ?? -1;
    return message && newline >= 0 ? message.slice(newline + 1).trim() || null : null;
}

/**
 * Pure mapping of the GitLab MR detail calls. `commits`, `approvals` and `pipelines` are optional
 * JSON bodies: a secondary call that failed leaves its fields null or empty, never the whole view.
 */
export function parseGlabMrView({
    mr,
    commits,
    approvals,
    pipelines,
}: {
    mr: string;
    commits?: string | null;
    approvals?: string | null;
    pipelines?: string | null;
}): PrDetail {
    const row = parseJson(mr, "glab");
    const summary = isRecord(row) ? glabSummary(row, new Map()) : null;

    if (!isRecord(row) || !summary) {
        throw new PrParseError("glab returned no MR with iid and web_url");
    }

    const diffRefs = isRecord(row.diff_refs) ? row.diff_refs : {};
    const approval = approvals ? parseJson(approvals, "glab approvals") : null;
    const pipelineRows = pipelines ? records(parseJson(pipelines, "glab pipelines")) : [];
    const changes = str(row.changes_count);
    const changedFiles = changes && /^\d+$/.test(changes) ? Number(changes) : null;
    let reviewDecision: string | null = null;
    let approvalCount: number | null = null;

    if (isRecord(approval)) {
        approvalCount = records(approval.approved_by).length;
        const left = num(approval.approvals_left);
        reviewDecision = approval.approved === true && (left ?? 0) === 0 ? "APPROVED" : left ? "REVIEW_REQUIRED" : null;
    }

    return {
        ...summary,
        headSha: str(diffRefs.head_sha) ?? summary.headSha,
        ci: summary.ci ?? toCi(pipelineRows[0] ? glabPipelineStatus(pipelineRows[0].status) : null),
        reviewDecision,
        approvals: approvalCount,
        body: str(row.description) ?? "",
        commits: commits
            ? records(parseJson(commits, "glab commits")).map((commit) => ({
                  sha: str(commit.id) ?? "",
                  title: str(commit.title) ?? "",
                  author: str(commit.author_name),
                  authorLogin: null,
                  date: str(commit.committed_date) ?? str(commit.authored_date),
                  body: glabCommitBody(str(commit.message)),
              }))
            : [],
        changedFiles,
        additions: null,
        deletions: null,
        baseSha: str(diffRefs.base_sha),
        mergeable: glabMergeable(row),
        mergeStatus: str(row.detailed_merge_status) ?? str(row.merge_status),
        checks: pipelineRows.map((pipeline) => ({
            name: `pipeline ${num(pipeline.id) ?? "?"}${str(pipeline.ref) ? ` (${str(pipeline.ref)})` : ""}`,
            status: glabPipelineStatus(pipeline.status),
            url: str(pipeline.web_url),
        })),
        webUrls: webUrls("gitlab", summary.url),
    };
}

function glabProject(project: ProjectRef): string {
    return `projects/${encodeURIComponent(project.path)}`;
}

function glabApi(project: ProjectRef, endpoint: string): string[] {
    return ["glab", "api", "--hostname", project.host, endpoint];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function run({
    cmd,
    cwd,
    runner,
}: {
    cmd: string[];
    cwd: string;
    runner: CommandRunner;
}): Promise<{ stdout: string; error: string | null }> {
    log.debug({ cmd, cwd }, "host query");
    const res = await runner(cmd, { cwd, timeoutMs: PR_QUERY_TIMEOUT_MS });

    if (res.code !== 0) {
        log.debug({ cmd, code: res.code, stderr: res.stderr }, "host query failed");
        return { stdout: "", error: res.stderr.trim() || `${cmd[0]} exited ${res.code}` };
    }

    return { stdout: res.stdout, error: null };
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** The logged-in user on the host (`gh api user` / `glab api user`); null with a debug line when unknown. */
export async function viewerLogin({
    project,
    cwd = process.cwd(),
    runner = spawnRunner,
}: {
    project: ProjectRef;
    cwd?: string;
    runner?: CommandRunner;
}): Promise<string | null> {
    const cmd =
        project.kind === "github"
            ? ["gh", "api", "--hostname", project.host, "user"]
            : ["glab", "api", "--hostname", project.host, "user"];
    const { stdout, error } = await run({ cmd, cwd, runner });

    if (error) {
        return null;
    }

    try {
        const user = parseJson(stdout, cmd[0]);
        return isRecord(user) ? str(user[project.kind === "github" ? "login" : "username"]) : null;
    } catch (err) {
        log.debug({ err, host: project.host }, "viewer lookup unreadable");
        return null;
    }
}

/**
 * Open (default), merged or all PRs/MRs of a project. Read-only. `updatedSince` asks the host for
 * only the PRs updated at or after that time, most recently updated first, so a date range is not
 * limited to the newest `limit` PRs of all time.
 */
export async function listPrs({
    project,
    state = "open",
    mine = false,
    limit = 30,
    updatedSince,
    cwd = process.cwd(),
    runner = spawnRunner,
}: {
    project: ProjectRef;
    state?: PrListState;
    mine?: boolean;
    limit?: number;
    updatedSince?: Date;
    cwd?: string;
    runner?: CommandRunner;
}): Promise<PrListResult> {
    const warnings: string[] = [];

    try {
        if (project.kind === "github" && updatedSince) {
            return await listGhUpdatedSince({ project, state, mine, limit, updatedSince, cwd, runner });
        }

        if (project.kind === "github") {
            const cmd = ["gh", "pr", "list", "--repo", ghRepoArg(project), "--state", state, "--limit", String(limit)];

            if (mine) {
                cmd.push("--author", "@me");
            }

            cmd.push("--json", GH_LIST_FIELDS.join(","));
            const res = await run({ cmd, cwd, runner });

            if (res.error) {
                return { prs: [], error: res.error, warnings };
            }

            const prs = parseGhPrRows(res.stdout);
            log.debug({ project: project.path, state, mine, updatedSince, count: prs.length }, "gh pr list");
            return { prs, error: null, warnings };
        }

        const query = new URLSearchParams({
            state: state === "open" ? "opened" : state,
            order_by: "updated_at",
            sort: "desc",
            per_page: String(Math.min(Math.max(limit, 1), GLAB_MAX_PER_PAGE)),
        });

        if (mine) {
            query.set("scope", "created_by_me");
        }

        if (updatedSince) {
            query.set("updated_after", updatedSince.toISOString());
        }

        const [mrs, pipelines] = await Promise.all([
            run({ cmd: glabApi(project, `${glabProject(project)}/merge_requests?${query}`), cwd, runner }),
            run({
                cmd: glabApi(project, `${glabProject(project)}/pipelines?per_page=100&order_by=id&sort=desc`),
                cwd,
                runner,
            }),
        ]);

        if (mrs.error) {
            return { prs: [], error: mrs.error, warnings };
        }

        let ciBySha = new Map<string, CheckStatus | null>();

        if (pipelines.error) {
            warnings.push(`pipelines: ${pipelines.error}`);
        } else {
            try {
                ciBySha = glabPipelinesBySha(pipelines.stdout);
            } catch (err) {
                warnings.push(`pipelines: ${errorText(err)}`);
            }
        }

        const prs = parseGlabMrRows(mrs.stdout, ciBySha).slice(0, limit);
        log.debug({ project: project.path, state, mine, updatedSince, count: prs.length, warnings }, "glab mr list");
        return { prs, error: null, warnings };
    } catch (err) {
        log.debug({ err, project: project.path }, "pr list failed");
        return { prs: [], error: errorText(err), warnings };
    }
}

/** One PR/MR with body, commits, checks and merge state. Read-only. */
export async function viewPr({
    project,
    number,
    cwd = process.cwd(),
    runner = spawnRunner,
}: {
    project: ProjectRef;
    number: number;
    cwd?: string;
    runner?: CommandRunner;
}): Promise<PrViewResult> {
    const warnings: string[] = [];

    try {
        if (project.kind === "github") {
            const res = await run({
                cmd: [
                    "gh",
                    "pr",
                    "view",
                    String(number),
                    "--repo",
                    ghRepoArg(project),
                    "--json",
                    GH_VIEW_FIELDS.join(","),
                ],
                cwd,
                runner,
            });

            return res.error
                ? { pr: null, error: res.error, warnings }
                : { pr: parseGhPrView(res.stdout), error: null, warnings };
        }

        const base = `${glabProject(project)}/merge_requests/${number}`;
        const [mr, commits, approvals, pipelines] = await Promise.all(
            [base, `${base}/commits?per_page=100`, `${base}/approvals`, `${base}/pipelines`].map((endpoint) =>
                run({ cmd: glabApi(project, endpoint), cwd, runner })
            )
        );

        if (mr.error) {
            return { pr: null, error: mr.error, warnings };
        }

        for (const [name, res] of [
            ["commits", commits],
            ["approvals", approvals],
            ["pipelines", pipelines],
        ] as const) {
            if (res.error) {
                warnings.push(`${name}: ${res.error}`);
            }
        }

        const pr = parseGlabMrView({
            mr: mr.stdout,
            commits: commits.error ? null : commits.stdout,
            approvals: approvals.error ? null : approvals.stdout,
            pipelines: pipelines.error ? null : pipelines.stdout,
        });
        return { pr, error: null, warnings };
    } catch (err) {
        log.debug({ err, project: project.path, number }, "pr view failed");
        return { pr: null, error: errorText(err), warnings };
    }
}
