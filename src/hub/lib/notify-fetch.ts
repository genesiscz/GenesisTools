import {
    type CommandRunner,
    listPrs,
    type ProjectRef,
    type PrSummary,
    spawnRunner,
    viewerLogin,
} from "@genesiscz/utils/git";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isBotLogin, type PrMemory, type PrSnapshot, type ThreadStart } from "./notify";

// One poll's read of one repo, as cheap as the hosts allow. GitHub: ONE GraphQL query per repo
// (open PRs with their newest threads, reviews and CI rollup, plus the recently merged ones; about
// 5 of the 5000 points an hour). GitLab: the MR list and the pipeline list, then discussions only
// for MRs whose note count moved since the last poll.

const log = logger.child({ component: "hub/notify-fetch" });

const QUERY_TIMEOUT_MS = 30_000;
const OPEN_PRS = 15;
const MERGED_PRS = 10;
const THREADS_PER_PR = 30;
const GITLAB_MRS = 20;

export const GITHUB_WATCH_QUERY = `
query($owner: String!, $repo: String!) {
  viewer { login }
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $repo) {
    open: pullRequests(first: ${OPEN_PRS}, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url headRefOid
        author { login }
        reviewThreads(last: ${THREADS_PER_PR}) { nodes { id path comments(first: 1) { nodes { author { __typename login } } } } }
        reviews(last: 10) { nodes { id state author { __typename login } } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
      }
    }
    merged: pullRequests(first: ${MERGED_PRS}, states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title url headRefOid author { login } }
    }
  }
}`;

export interface RateInfo {
    remaining: number;
    resetAt: string;
    cost: number;
}

export interface RepoFetch {
    prs: PrSnapshot[];
    viewer: string | null;
    rate: RateInfo | null;
    /** Host calls this fetch made, for the poll's request-rate report. */
    requests: number;
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

function nodes(value: unknown): Record<string, unknown>[] {
    return isRecord(value) ? records(value.nodes) : [];
}

function login(value: unknown): { login: string | null; bot: boolean } {
    return isRecord(value) ? { login: str(value.login), bot: value.__typename === "Bot" } : { login: null, bot: false };
}

/** GitHub's rollup states onto the hub's CI words; EXPECTED and PENDING both wait. */
function githubCi(state: string | null): PrSnapshot["ci"] {
    switch (state) {
        case "SUCCESS":
            return "success";
        case "FAILURE":
        case "ERROR":
            return "failed";
        case "PENDING":
        case "EXPECTED":
            return "pending";
        default:
            return null;
    }
}

export class HostError extends Error {
    constructor(
        message: string,
        /** The host refused for rate reasons: back off harder. */
        readonly rateLimited: boolean
    ) {
        super(message);
        this.name = "HostError";
    }
}

function rateLimitedText(text: string): boolean {
    return /rate limit|secondary rate|abuse detection|\b429\b|too many requests/i.test(text);
}

/** The GraphQL answer into snapshots; exported for tests. */
export function parseGithubWatch({
    json,
    project,
    botLogins,
}: {
    json: string;
    project: ProjectRef;
    botLogins: string[];
}): { prs: PrSnapshot[]; viewer: string | null; rate: RateInfo | null } {
    const root = SafeJSON.parse(json, { strict: true });

    if (!isRecord(root) || !isRecord(root.data)) {
        const errors = isRecord(root) ? records(root.errors).map((e) => str(e.message) ?? "error") : [];
        throw new HostError(errors.join("; ") || "GitHub returned no data", errors.some(rateLimitedText));
    }

    const data = root.data;
    const viewer = login(data.viewer).login;
    const rateRaw = isRecord(data.rateLimit) ? data.rateLimit : null;
    const rate =
        rateRaw && typeof rateRaw.remaining === "number"
            ? { remaining: rateRaw.remaining, resetAt: str(rateRaw.resetAt) ?? "", cost: Number(rateRaw.cost ?? 0) }
            : null;
    const repo = isRecord(data.repository) ? data.repository : null;

    if (!repo) {
        throw new HostError(`GitHub has no repository ${project.path}`, false);
    }

    const snapshot = (pr: Record<string, unknown>, state: PrSnapshot["state"]): PrSnapshot | null => {
        const number = typeof pr.number === "number" ? pr.number : null;

        if (number === null) {
            return null;
        }

        const author = login(pr.author).login;
        const threads: ThreadStart[] = nodes(pr.reviewThreads).map((thread) => {
            const [first] = nodes(thread.comments);
            const who = login(first?.author);
            return {
                id: str(thread.id) ?? "",
                author: who.login,
                bot: isBotLogin(who.login, botLogins, who.bot),
                path: str(thread.path),
            };
        });
        const botReviews = nodes(pr.reviews).flatMap((review) => {
            const who = login(review.author);
            const id = str(review.id);
            return id && who.login && isBotLogin(who.login, botLogins, who.bot)
                ? [{ id, author: who.login, state: str(review.state) }]
                : [];
        });
        const [lastCommit] = nodes(pr.commits);
        const commit = isRecord(lastCommit?.commit) ? lastCommit.commit : null;
        const rollup = commit && isRecord(commit.statusCheckRollup) ? str(commit.statusCheckRollup.state) : null;

        return {
            key: `${project.host}/${project.path}#${number}`,
            provider: "github",
            project: project.path,
            number,
            title: str(pr.title) ?? "",
            url: str(pr.url) ?? "",
            author,
            mine: viewer !== null && author === viewer,
            state,
            headSha: str(pr.headRefOid) ?? (commit ? str(commit.oid) : null),
            ci: state === "OPEN" ? githubCi(rollup) : null,
            threads: state === "OPEN" ? threads.filter((t) => t.id !== "") : [],
            notes: null,
            botReviews,
        };
    };

    const prs = [
        ...nodes(isRecord(repo.open) ? repo.open : null).map((pr) => snapshot(pr, "OPEN")),
        ...nodes(isRecord(repo.merged) ? repo.merged : null).map((pr) => snapshot(pr, "MERGED")),
    ].filter((pr): pr is PrSnapshot => pr !== null);
    return { prs, viewer, rate };
}

async function runHost(runner: CommandRunner, cmd: string[]): Promise<string> {
    log.debug({ cmd: cmd.slice(0, 5) }, "notify host query");
    const res = await runner(cmd, { cwd: process.cwd(), timeoutMs: QUERY_TIMEOUT_MS });

    if (res.code !== 0) {
        const text = res.stderr.trim() || `${cmd[0]} exited ${res.code}`;
        throw new HostError(text, rateLimitedText(text));
    }

    return res.stdout;
}

export async function fetchGithubRepo({
    project,
    botLogins,
    runner = spawnRunner,
}: {
    project: ProjectRef;
    botLogins: string[];
    runner?: CommandRunner;
}): Promise<RepoFetch> {
    const [owner, ...rest] = project.path.split("/");
    const stdout = await runHost(runner, [
        "gh",
        "api",
        "graphql",
        "--hostname",
        project.host,
        "-f",
        `query=${GITHUB_WATCH_QUERY}`,
        // Raw strings: `-F` would send a repo named `2048` as an Int to a `String!` variable.
        "-f",
        `owner=${owner}`,
        "-f",
        `repo=${rest.join("/")}`,
    ]);
    return { ...parseGithubWatch({ json: stdout, project, botLogins }), requests: 1 };
}

/** GitLab discussions into thread starts; one-note comments (`individual_note`) are not threads. */
export function parseGitlabDiscussions(json: string, botLogins: string[]): ThreadStart[] {
    return records(SafeJSON.parse(json, { strict: true })).flatMap((discussion) => {
        const [first] = records(discussion.notes);

        if (discussion.individual_note === true || !first || first.system === true) {
            return [];
        }

        const author = isRecord(first.author) ? str(first.author.username) : null;
        const position = isRecord(first.position) ? first.position : null;
        return [
            {
                id: String(discussion.id ?? ""),
                author,
                bot: isBotLogin(author, botLogins, isRecord(first.author) && first.author.bot === true),
                path: position ? (str(position.new_path) ?? str(position.old_path)) : null,
            },
        ].filter((t) => t.id !== "");
    });
}

function gitlabSnapshot(project: ProjectRef, pr: PrSummary, viewer: string | null): PrSnapshot {
    return {
        key: `${project.host}/${project.path}#${pr.number}`,
        provider: "gitlab",
        project: project.path,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        mine: viewer !== null && pr.author === viewer,
        state: pr.state,
        headSha: pr.headSha,
        ci: pr.state === "OPEN" ? pr.ci : null,
        threads: null,
        notes: pr.comments,
        botReviews: [],
    };
}

export async function fetchGitlabRepo({
    project,
    botLogins,
    memory,
    viewer: knownViewer,
    runner = spawnRunner,
}: {
    project: ProjectRef;
    botLogins: string[];
    /** The last poll's memories, keyed like {@link PrSnapshot.key}: an unchanged note count skips discussions. */
    memory: Record<string, PrMemory>;
    viewer?: string | null;
    runner?: CommandRunner;
}): Promise<RepoFetch> {
    let requests = 2;
    const viewer = knownViewer ?? (await viewerLogin({ project, runner }));

    if (knownViewer === undefined) {
        requests += 1;
    }

    const listed = await listPrs({ project, state: "all", limit: GITLAB_MRS, runner });

    if (listed.error) {
        throw new HostError(listed.error, rateLimitedText(listed.error));
    }

    const prs: PrSnapshot[] = [];

    for (const summary of listed.prs) {
        const pr = gitlabSnapshot(project, summary, viewer);
        const previous = memory[pr.key];

        // A first sighting reads the threads too (when there are any), so the baseline holds them and
        // the next change does not report every old thread as new.
        const changed = previous ? pr.notes !== previous.notes : (pr.notes ?? 0) > 0;

        if (pr.state === "OPEN" && pr.notes !== null && changed) {
            const endpoint = `projects/${encodeURIComponent(project.path)}/merge_requests/${pr.number}/discussions?per_page=100`;
            const json = await runHost(runner, ["glab", "api", "--hostname", project.host, endpoint]);
            requests += 1;
            const threads = parseGitlabDiscussions(json, botLogins);
            pr.threads = threads;
            // GitLab has no review object; a bot's review is the thread it opens.
            pr.botReviews = threads
                .filter((t) => t.bot && t.author)
                .map((t) => ({ id: t.id, author: t.author ?? "", state: null }));
        }

        prs.push(pr);
    }

    return { prs, viewer, rate: null, requests };
}
