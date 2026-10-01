import { defaultReviewCommentClient } from "@app/github/lib/review-comments";
import { resolveProjectApi } from "@app/gitlab/lib/client";
import type { CommandRunner } from "@genesiscz/utils/git/origins";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { Storage } from "@genesiscz/utils/storage";
import { cached } from "@genesiscz/utils/storage/cache-flag";
import { type FactsReader, findBranchPr, findPrByRef } from "./find";
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
        return githubBackend({ pr, client: defaultReviewCommentClient() });
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

function cacheKey(pr: FoundPr): string {
    const slug = `${pr.provider}-${pr.host}-${pr.project}-${pr.number}`.replace(/[^A-Za-z0-9._-]+/g, "_");
    return `pr-threads/${slug}.json`;
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
}: {
    pr: FoundPr;
    backend: PrBackend;
    maxCacheAgeSeconds?: number;
    storage?: Storage;
}): Promise<ThreadsResult> {
    const key = cacheKey(pr);
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
export async function forgetThreads({ pr, storage = cacheStorage() }: { pr: FoundPr; storage?: Storage }) {
    await storage.deleteCacheFile(cacheKey(pr));
}
