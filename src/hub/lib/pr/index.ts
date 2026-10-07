import { createHash } from "node:crypto";
import { defaultReviewCommentClient } from "@app/github/lib/review-comments";
import { resolveProjectApi } from "@app/gitlab/lib/client";
import type { CommandRunner } from "@genesiscz/utils/git/origins";
import { getOctokitForWrite } from "@genesiscz/utils/github/octokit";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { Storage } from "@genesiscz/utils/storage";
import { cached } from "@genesiscz/utils/storage/cache-flag";
import { explicitPrTarget, type FactsReader, findBranchPr, findPrByRef } from "./find";
import { githubBackend } from "./github";
import { gitlabBackend } from "./gitlab";
import { type FoundPr, HubPrError, type PrBackend, type ThreadsResult } from "./types";

export { findBranchPr, findPrByRef } from "./find";
export * from "./types";

const log = logger.child({ component: "hub/pr" });
const prof = profiler.scope("hub-pr");
/** How old a thread list a library caller gets when it does not say (the window polls while open). */
const THREADS_MAX_AGE_SECONDS = 30;

/**
 * The PR/MR a verb works on: the one named by `pr` (URL or `<repoPath>#<n>`) when given, else the one
 * of the branch at `repo`; `no-pr` when the branch has none (the reason is the message).
 */
export async function resolvePr(options: {
    repo: string;
    pr?: string;
    runner?: CommandRunner;
    readFacts?: FactsReader;
}): Promise<FoundPr> {
    if (options.pr) {
        const ref = options.pr;
        return prof.measureAsync("resolve.ref", () =>
            findPrByRef({ ref, runner: options.runner, readFacts: options.readFacts })
        );
    }

    const found = await prof.measureAsync("resolve.branch", () => findBranchPr(options));

    if (found.provider === null) {
        throw new HubPrError("no-pr", found.reason);
    }

    return found;
}

/** The provider backend with the logged-in identity: octokit for GitHub, the GitLab HTTP client otherwise. */
export async function backendFor(pr: FoundPr): Promise<PrBackend> {
    if (pr.provider === "github") {
        return githubBackend({ pr, client: defaultReviewCommentClient({ host: pr.host }) });
    }

    const api = await prof.measureAsync("backend.gitlab", () =>
        resolveProjectApi({ host: gitlabBaseUrl(pr), project: pr.project })
    );
    return gitlabBackend({ pr, api });
}

/**
 * An MR's GitLab base URL with its relative root: `https://host/gitlab` for
 * `https://host/gitlab/group/app/-/merge_requests/9`. The origin alone sent every call of an
 * install under a relative root to `https://host/api/v4`.
 */
export function gitlabBaseUrl(pr: Pick<FoundPr, "url" | "project">): string {
    const url = new URL(pr.url);
    const at = url.pathname.indexOf(`/${pr.project}/`);
    return `${url.origin}${at > 0 ? url.pathname.slice(0, at) : ""}`;
}

function cacheStorage(): Storage {
    return new Storage("hub");
}

function cacheKey(pr: Pick<FoundPr, "provider" | "host" | "project" | "number">, identity = "unscoped"): string {
    const fingerprint = createHash("sha256")
        .update([pr.provider, pr.host, pr.project, pr.number, identity].join("\0"))
        .digest("hex");
    return `pr-threads/${fingerprint}.json`;
}

/**
 * The PR URL as a cache key: the URL a user typed and the one the host returns must give the same
 * key, or a write never invalidates the explicit read. Host case, `www.`, case in the path and a
 * tab suffix after the number (`/files`, `/diffs`) are dropped. The URL is kept rather than the
 * parsed project because a GitLab relative root (`/gitlab/group/app`) parses differently from
 * the project the API returns.
 */
function explicitCacheUrl(raw: string): string {
    const url = new URL(raw);
    const host = url.host.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/(\/(?:pull|-\/merge_requests)\/\d+)(?:\/.*)?$/, "$1").replace(/\/$/, "");
    return `${url.protocol}//${host}${path}`.toLowerCase();
}

function explicitCacheKey(pr: Pick<FoundPr, "url">, identity: string): string {
    const fingerprint = createHash("sha256")
        .update(`${explicitCacheUrl(pr.url)}\0${identity}`)
        .digest("hex");
    return `pr-threads/explicit-${fingerprint}.json`;
}

type ExplicitTarget = NonNullable<Awaited<ReturnType<typeof explicitPrTarget>>>;

export async function reviewCacheIdentity(pr: ExplicitTarget): Promise<string> {
    let token: string;

    if (pr.provider === "github") {
        if (pr.host.toLowerCase() !== "github.com") {
            throw new HubPrError("unsupported", "GitHub review operations support github.com only");
        }

        const auth: unknown = await getOctokitForWrite().auth();

        if (typeof auth !== "object" || auth === null || !("token" in auth) || typeof auth.token !== "string") {
            throw new HubPrError("provider", "GitHub review identity is unavailable");
        }

        token = auth.token;
    } else {
        token = (await resolveProjectApi({ host: gitlabBaseUrl(pr), project: pr.project })).token;
    }

    return createHash("sha256").update(token).digest("hex");
}

const threadReads = new Map<string, Promise<ThreadsResult>>();

export async function readPrThreads({
    repo,
    pr,
    maxCacheAgeSeconds = 0,
    storage = cacheStorage(),
    readFacts,
    runner,
    identityFor = reviewCacheIdentity,
    resolve = resolvePr,
    makeBackend = backendFor,
}: {
    repo: string;
    pr?: string;
    maxCacheAgeSeconds?: number;
    storage?: Storage;
    readFacts?: FactsReader;
    runner?: CommandRunner;
    identityFor?: typeof reviewCacheIdentity;
    resolve?: typeof resolvePr;
    makeBackend?: typeof backendFor;
}): Promise<ThreadsResult> {
    const target = pr ? await explicitPrTarget({ ref: pr, readFacts }) : null;

    if (!target) {
        const found = await resolve({ repo, pr, readFacts, runner });
        const identity = await identityFor(found);
        return prThreads({
            pr: found,
            backend: await makeBackend(found),
            maxCacheAgeSeconds,
            storage,
            cacheIdentity: identity,
        });
    }

    const identity = await identityFor(target);
    const key = explicitCacheKey(target, identity);
    const flightKey = `${storage.getCacheDir()}/${key}`;
    const read = async (): Promise<ThreadsResult> => {
        if (maxCacheAgeSeconds > 0) {
            const stored = await storage.getCacheFile<ThreadsResult>(key, `${Math.ceil(maxCacheAgeSeconds)} seconds`);

            if (stored) {
                return { ...stored, cached: true };
            }
        }

        const found = await resolve({ repo, pr, readFacts, runner });
        return prThreads({
            pr: found,
            backend: await makeBackend(found),
            maxCacheAgeSeconds: 0,
            storage,
            cacheIdentity: identity,
            cacheKeyOverride: key,
        });
    };

    if (maxCacheAgeSeconds <= 0) {
        return read();
    }

    const existing = threadReads.get(flightKey);

    if (existing) {
        return existing;
    }

    const pending = read().finally(() => {
        if (threadReads.get(flightKey) === pending) {
            threadReads.delete(flightKey);
        }
    });
    threadReads.set(flightKey, pending);
    return pending;
}

/**
 * Threads of one PR, from a per-PR cache at most `maxCacheAgeSeconds` old (30 s when unset; 0 asks the
 * host). A cached list for another head is never served.
 */
export async function prThreads({
    pr,
    backend,
    maxCacheAgeSeconds = THREADS_MAX_AGE_SECONDS,
    storage = cacheStorage(),
    cacheIdentity = "unscoped",
    cacheKeyOverride,
}: {
    pr: FoundPr;
    backend: PrBackend;
    maxCacheAgeSeconds?: number;
    storage?: Storage;
    cacheIdentity?: string;
    cacheKeyOverride?: string;
}): Promise<ThreadsResult> {
    const key = cacheKeyOverride ?? cacheKey(pr, cacheIdentity);
    const { value, hit } = await cached<ThreadsResult>({
        storage,
        key,
        maxAgeSeconds: maxCacheAgeSeconds,
        isValid: (stored) => stored.pr.headSha === pr.headSha,
        fetch: async () => ({
            pr,
            ...(await prof.measureAsync(`threads.fetch ${pr.project}#${pr.number}`, () => backend.threads())),
            cached: false,
            fetchedAt: new Date().toISOString(),
        }),
    });

    if (hit) {
        log.debug({ key }, "hub pr threads: cache hit");
        return { ...value, pr, cached: true };
    }

    log.debug({ key, threads: value.threads.length, drafts: value.draftCount }, "hub pr threads: fetched");
    return value;
}

/** A write changed what `threads` returns; the next read must not serve the old answer. */
export async function forgetThreads({
    pr,
    storage = cacheStorage(),
    cacheIdentity = "unscoped",
}: {
    pr: FoundPr;
    storage?: Storage;
    cacheIdentity?: string;
}) {
    for (const key of [cacheKey(pr, cacheIdentity), explicitCacheKey(pr, cacheIdentity)]) {
        const pending = threadReads.get(`${storage.getCacheDir()}/${key}`);

        if (pending) {
            await pending.catch((error: unknown) =>
                log.debug({ error }, "preceding thread read failed during invalidation")
            );
        }

        await storage.deleteCacheFile(key);
    }
}
