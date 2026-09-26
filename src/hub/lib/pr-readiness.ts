import { defaultReviewCommentClient } from "@app/github/lib/review-comments";
import type { CiStatus } from "@genesiscz/utils/git/origins";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { backendFor, findPrByRef, prThreads } from "./pr";
import { hubPr } from "./prs";

// "Ready to merge?" for one PR/MR, with the reason: unresolved review threads that are not outdated
// (every reviewer, bots included, never filtered to one), CI, whether the newest review is older than
// the newest push, conflicts, a draft, requested changes. One GraphQL query per GitHub PR; GitLab
// through the hub's own MR detail and threads. Cached per PR and head SHA, so the hub asks the forge
// again only when a push moved the head (or the entry is 10 minutes old): never more often than it
// already loads the PR list.

const log = logger.child({ component: "hub/pr-readiness" });

/** A cached answer for the same head is served this long; a new push always fetches. */
export const READINESS_HEAD_TTL_MS = 10 * 60_000;
/** Without a known head (a bare CLI call), a cached answer is served this long. */
export const READINESS_BARE_TTL_MS = 60_000;
const CACHE_TTL = "1 day";
const THREAD_PAGE = 100;
const MAX_THREAD_PAGES = 10;

export type ReadinessVerdict = "ready" | "waiting" | "blocked" | "closed";

export interface ThreadAuthorCount {
    author: string;
    count: number;
}

/** What the verdict is judged from; each provider fills what it can, null where it cannot know. */
export interface ReadinessFacts {
    url: string;
    provider: "github" | "gitlab";
    number: number;
    title: string | null;
    state: "open" | "merged" | "closed";
    draft: boolean;
    headSha: string | null;
    /** null: the head has no checks at all. */
    ci: CiStatus | null;
    threads: Array<{ resolved: boolean; outdated: boolean; author: string }>;
    /** Submitted reviews, oldest first; `commit` is the head each one looked at. */
    reviews: Array<{ author: string; state: string; submittedAt: string; commit: string | null }>;
    lastPushAt: string | null;
    reviewDecision: string | null;
    mergeable: "mergeable" | "conflicting" | "unknown" | null;
    /** The provider has no per-review head (GitLab): the "older than the push" check is skipped. */
    reviewsKnown: boolean;
}

export interface PrReadiness {
    url: string;
    provider: "github" | "gitlab";
    number: number;
    title: string | null;
    headSha: string | null;
    state: ReadinessFacts["state"];
    draft: boolean;
    ci: CiStatus | null;
    /** Unresolved threads that are not outdated. */
    unresolved: number;
    unresolvedBy: ThreadAuthorCount[];
    /** Unresolved but outdated: listed, never blocking. */
    outdatedUnresolved: number;
    lastReviewAt: string | null;
    lastReviewBy: string | null;
    lastPushAt: string | null;
    /** The newest review looked at the current head; null when unknown or there is no review. */
    reviewedHead: boolean | null;
    /** Reviewers whose newest review looked at an older head. */
    staleReviewers: string[];
    reviewDecision: string | null;
    mergeable: ReadinessFacts["mergeable"];
    verdict: ReadinessVerdict;
    /** Every reason, blocking ones first; empty when ready. */
    reasons: string[];
    /** One line: the verdict and its first reason. */
    summary: string;
    fetchedAt: string;
    cached: boolean;
}

function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}

/** Threads by the author of their first comment, most first: every reviewer, bots included. */
export function countByAuthor(authors: string[]): ThreadAuthorCount[] {
    const counts = new Map<string, number>();

    for (const author of authors) {
        counts.set(author, (counts.get(author) ?? 0) + 1);
    }

    return [...counts]
        .map(([author, count]) => ({ author, count }))
        .sort((a, b) => b.count - a.count || a.author.localeCompare(b.author));
}

/** The verdict and its reasons. Pure: the tests and every door judge the same way. */
export function judgeReadiness(facts: ReadinessFacts, now: Date): Omit<PrReadiness, "fetchedAt" | "cached"> {
    const open = facts.threads.filter((thread) => !thread.resolved);
    const live = open.filter((thread) => !thread.outdated);
    const unresolvedBy = countByAuthor(live.map((thread) => thread.author));
    const reviews = facts.reviews.filter((review) => review.state !== "PENDING" && review.state !== "DISMISSED");
    const last = reviews.reduce<ReadinessFacts["reviews"][number] | null>(
        (newest, review) => (newest === null || review.submittedAt > newest.submittedAt ? review : newest),
        null
    );
    const latestBy = new Map<string, ReadinessFacts["reviews"][number]>();

    for (const review of reviews) {
        const seen = latestBy.get(review.author);

        if (!seen || review.submittedAt > seen.submittedAt) {
            latestBy.set(review.author, review);
        }
    }

    const reviewedHead =
        !facts.reviewsKnown || !last || !facts.headSha
            ? null
            : last.commit === facts.headSha ||
              (last.commit === null && facts.lastPushAt !== null && last.submittedAt >= facts.lastPushAt);
    const staleReviewers =
        facts.reviewsKnown && facts.headSha
            ? [...latestBy.values()]
                  .filter((review) => review.commit !== null && review.commit !== facts.headSha)
                  .map((review) => review.author)
                  .sort()
            : [];

    const blocking: string[] = [];
    const waiting: string[] = [];

    if (facts.draft) {
        blocking.push("it is a draft");
    }

    if (facts.ci === "failed") {
        blocking.push("CI failed");
    }

    if (live.length > 0) {
        const who = unresolvedBy.map((entry) => `${entry.author} ×${entry.count}`).join(", ");
        blocking.push(`${plural(live.length, "unresolved thread")} (${who})`);
    }

    if (facts.reviewDecision === "CHANGES_REQUESTED") {
        blocking.push("changes are requested");
    }

    if (facts.mergeable === "conflicting") {
        blocking.push("it has merge conflicts");
    }

    if (facts.ci === "running" || facts.ci === "pending") {
        waiting.push("CI is still running");
    }

    if (reviewedHead === false && last) {
        waiting.push(`the last review (${last.author}, ${ago(last.submittedAt, now)}) is older than the last push`);
    }

    if (facts.reviewsKnown && reviews.length === 0) {
        waiting.push("no review yet");
    }

    if (facts.reviewDecision === "REVIEW_REQUIRED") {
        waiting.push("a required review is missing");
    }

    const verdict: ReadinessVerdict =
        facts.state !== "open" ? "closed" : blocking.length > 0 ? "blocked" : waiting.length > 0 ? "waiting" : "ready";
    const reasons = facts.state !== "open" ? [facts.state] : [...blocking, ...waiting];
    const summary =
        verdict === "ready"
            ? `ready to merge: ${facts.ci === "success" ? "CI green" : "no CI checks"}, no open threads${reviewedHead ? ", the head is reviewed" : ""}`
            : verdict === "closed"
              ? facts.state
              : `${verdict}: ${reasons[0]}${reasons.length > 1 ? ` (+${reasons.length - 1} more)` : ""}`;

    return {
        url: facts.url,
        provider: facts.provider,
        number: facts.number,
        title: facts.title,
        headSha: facts.headSha,
        state: facts.state,
        draft: facts.draft,
        ci: facts.ci,
        unresolved: live.length,
        unresolvedBy,
        outdatedUnresolved: open.length - live.length,
        lastReviewAt: last?.submittedAt ?? null,
        lastReviewBy: last?.author ?? null,
        lastPushAt: facts.lastPushAt,
        reviewedHead,
        staleReviewers,
        reviewDecision: facts.reviewDecision,
        mergeable: facts.mergeable,
        verdict,
        reasons,
        summary,
    };
}

function ago(iso: string, now: Date): string {
    const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));

    if (minutes < 60) {
        return `${minutes} min ago`;
    }

    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

// ---------------------------------------------------------------------------
// GitHub: one query (plus thread pages past 100)

const READINESS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title state isDraft url headRefOid mergeable reviewDecision author { login }
      commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { state } } } }
      reviews(last: 100) { nodes { author { login } state submittedAt commit { oid } } }
      reviewThreads(first: ${THREAD_PAGE}) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved isOutdated comments(first: 1) { nodes { author { login } } } }
      }
      timelineItems(last: 1, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
        nodes { ... on HeadRefForcePushedEvent { createdAt } }
      }
    }
  }
}`;

const THREADS_PAGE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREAD_PAGE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved isOutdated comments(first: 1) { nodes { author { login } } } }
      }
    }
  }
}`;

interface RawThreadPage {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
        isResolved: boolean;
        isOutdated: boolean;
        comments: { nodes: Array<{ author: { login: string } | null }> };
    }>;
}

export interface RawReadiness {
    repository: {
        pullRequest: {
            number: number;
            title: string;
            state: "OPEN" | "MERGED" | "CLOSED";
            isDraft: boolean;
            url: string;
            headRefOid: string;
            author: { login: string } | null;
            mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
            reviewDecision: string | null;
            commits: {
                nodes: Array<{
                    commit: { oid: string; committedDate: string; statusCheckRollup: { state: string } | null };
                }>;
            };
            reviews: {
                nodes: Array<{
                    author: { login: string } | null;
                    state: string;
                    submittedAt: string | null;
                    commit: { oid: string } | null;
                }>;
            };
            reviewThreads: RawThreadPage;
            timelineItems: { nodes: Array<{ createdAt?: string }> };
        } | null;
    } | null;
}

/** GitHub's rollup state as the hub's CI words (`CiStatus` in src/utils/git/origins/prs.ts). */
export function rollupToCi(state: string | null | undefined): CiStatus | null {
    switch (state) {
        case "SUCCESS":
            return "success";
        case "FAILURE":
        case "ERROR":
            return "failed";
        case "PENDING":
            return "running";
        case "EXPECTED":
            return "pending";
        default:
            return null;
    }
}

export function githubFacts(raw: RawReadiness, extraThreads: RawThreadPage["nodes"] = []): ReadinessFacts | null {
    const pr = raw.repository?.pullRequest;

    if (!pr) {
        return null;
    }

    const head = pr.commits.nodes[0]?.commit;
    const forced = pr.timelineItems.nodes[0]?.createdAt ?? null;
    const lastPushAt =
        [head?.committedDate ?? null, forced]
            .filter((value) => value !== null)
            .sort()
            .pop() ?? null;

    return {
        url: pr.url,
        provider: "github",
        number: pr.number,
        title: pr.title,
        state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
        draft: pr.isDraft,
        headSha: pr.headRefOid,
        ci: rollupToCi(head?.statusCheckRollup?.state),
        threads: [...pr.reviewThreads.nodes, ...extraThreads].map((thread) => ({
            resolved: thread.isResolved,
            outdated: thread.isOutdated,
            author: thread.comments.nodes[0]?.author?.login ?? "ghost",
        })),
        // The author's own replies arrive as COMMENTED reviews; they review nothing.
        reviews: pr.reviews.nodes
            .filter((review) => review.submittedAt !== null && !(pr.author && review.author?.login === pr.author.login))
            .map((review) => ({
                author: review.author?.login ?? "ghost",
                state: review.state,
                submittedAt: review.submittedAt ?? "",
                commit: review.commit?.oid ?? null,
            })),
        lastPushAt,
        reviewDecision: pr.reviewDecision,
        mergeable:
            pr.mergeable === "MERGEABLE" ? "mergeable" : pr.mergeable === "CONFLICTING" ? "conflicting" : "unknown",
        reviewsKnown: true,
    };
}

/** `https://github.com/<owner>/<repo>/pull/<n>` (any host with that shape); null otherwise. */
export function parseGithubPrUrl(url: string): { owner: string; repo: string; number: number } | null {
    const match = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/);
    return match ? { owner: match[1], repo: match[2], number: Number(match[3]) } : null;
}

// ---------------------------------------------------------------------------
// Fetching, with a cache per PR and head

export interface ReadinessDeps {
    graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
    /** A PR/MR that is not a github.com URL: resolved and judged through the hub's own readers. */
    other(ref: string): Promise<ReadinessFacts>;
    storage: Pick<Storage, "getCacheFile" | "putCacheFile">;
    now(): Date;
}

async function otherFacts(ref: string): Promise<ReadinessFacts> {
    const found = await findPrByRef({ ref });
    const [detail, threads] = await Promise.all([
        hubPr({ ref: found.url }),
        backendFor(found).then((backend) => prThreads({ pr: found, backend })),
    ]);

    return {
        url: found.url,
        provider: found.provider === "gitlab" ? "gitlab" : "github",
        number: found.number,
        title: found.title,
        state: detail.state === "OPEN" ? "open" : detail.state === "MERGED" ? "merged" : "closed",
        draft: found.draft,
        headSha: found.headSha,
        ci: detail.ci,
        threads: threads.threads
            .filter((thread) => thread.resolvable || thread.resolved)
            .map((thread) => ({
                resolved: thread.resolved,
                outdated: thread.outdated,
                author: thread.comments[0]?.author.username ?? "ghost",
            })),
        reviews: [],
        lastPushAt: null,
        reviewDecision: detail.reviewDecision,
        mergeable: detail.mergeable,
        reviewsKnown: false,
    };
}

export const realReadinessDeps: ReadinessDeps = {
    graphql: (query, variables) => defaultReviewCommentClient().graphql(query, variables),
    other: otherFacts,
    storage: new Storage("hub"),
    now: () => new Date(),
};

/** `<ref>@<sha>`: a ref with the head the caller already knows (the hub's PR list). */
export function splitKnownHead(input: string): { ref: string; head: string | null } {
    const match = input.match(/^(.*)@([0-9a-f]{7,40})$/i);
    return match ? { ref: match[1], head: match[2].toLowerCase() } : { ref: input, head: null };
}

function cacheKey(ref: string): string {
    return `pr-readiness/${ref.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
}

async function fetchFacts(ref: string, deps: ReadinessDeps): Promise<ReadinessFacts> {
    const parsed = parseGithubPrUrl(ref);

    if (!parsed || !/^https?:\/\/github\.com\//.test(ref)) {
        return deps.other(ref);
    }

    const vars = { owner: parsed.owner, repo: parsed.repo, number: parsed.number };
    const raw = await deps.graphql<RawReadiness>(READINESS_QUERY, vars);
    const extra: RawThreadPage["nodes"] = [];
    let page = raw.repository?.pullRequest?.reviewThreads.pageInfo;

    for (let count = 1; page?.hasNextPage && page.endCursor && count < MAX_THREAD_PAGES; count++) {
        const next = await deps.graphql<{
            repository: { pullRequest: { reviewThreads: RawThreadPage } | null } | null;
        }>(THREADS_PAGE_QUERY, { ...vars, cursor: page.endCursor });
        const threads = next.repository?.pullRequest?.reviewThreads;
        extra.push(...(threads?.nodes ?? []));
        page = threads?.pageInfo;
    }

    const facts = githubFacts(raw, extra);

    if (!facts) {
        throw new Error(`${ref}: the PR was not found`);
    }

    return facts;
}

/**
 * Readiness of one PR. `ref` is a PR/MR URL or `<repoPath>#<n>`, optionally `@<headSha>`: with a head,
 * a cached answer for that head under 10 minutes old is served without a forge call.
 */
export async function prReadiness({
    input,
    fresh = false,
    deps = realReadinessDeps,
}: {
    input: string;
    fresh?: boolean;
    deps?: ReadinessDeps;
}): Promise<PrReadiness> {
    const { ref, head } = splitKnownHead(input.trim());
    const key = cacheKey(ref);
    const now = deps.now();

    if (!fresh) {
        const hit = await deps.storage.getCacheFile<PrReadiness>(key, CACHE_TTL);
        const age = hit ? now.getTime() - Date.parse(hit.fetchedAt) : Number.POSITIVE_INFINITY;
        const valid =
            hit &&
            (head
                ? hit.headSha?.toLowerCase().startsWith(head) && age < READINESS_HEAD_TTL_MS
                : age < READINESS_BARE_TTL_MS);

        if (hit && valid) {
            log.debug({ ref, head, ageMs: age }, "pr readiness: cache hit");
            return { ...hit, cached: true };
        }
    }

    const facts = await fetchFacts(ref, deps);
    const result: PrReadiness = { ...judgeReadiness(facts, now), fetchedAt: now.toISOString(), cached: false };
    await deps.storage.putCacheFile(key, result, CACHE_TTL);
    // debug: the verdict is the command's own output; at info it printed a second time on the console.
    log.debug(
        {
            ref,
            verdict: result.verdict,
            unresolved: result.unresolved,
            ci: result.ci,
            reviewedHead: result.reviewedHead,
        },
        "pr readiness: fetched"
    );
    return result;
}

export interface ReadinessOutcome {
    input: string;
    readiness: PrReadiness | null;
    error: string | null;
}

/** Several PRs, a few at a time; one failure is that PR's error, never the whole list's. */
export async function prReadinessMany({
    inputs,
    fresh = false,
    concurrency = 4,
    deps = realReadinessDeps,
}: {
    inputs: string[];
    fresh?: boolean;
    concurrency?: number;
    deps?: ReadinessDeps;
}): Promise<ReadinessOutcome[]> {
    const outcomes: ReadinessOutcome[] = new Array(inputs.length);
    let next = 0;

    const worker = async (): Promise<void> => {
        while (next < inputs.length) {
            const index = next++;
            const input = inputs[index];

            try {
                outcomes[index] = { input, readiness: await prReadiness({ input, fresh, deps }), error: null };
            } catch (err) {
                log.warn({ err, input }, "pr readiness failed");
                outcomes[index] = { input, readiness: null, error: err instanceof Error ? err.message : String(err) };
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));
    return outcomes;
}
