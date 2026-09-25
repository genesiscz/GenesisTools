import { defaultReviewCommentClient } from "@app/github/lib/review-comments";
import { resolveProjectApi } from "@app/gitlab/lib/client";
import type { CommandRunner } from "@genesiscz/utils/git/origins";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { type FactsReader, findBranchPr, findPrByRef } from "./find";
import { githubBackend } from "./github";
import { gitlabBackend } from "./gitlab";
import { type FoundPr, HubPrError, type PrBackend, type ThreadsResult } from "./types";

export { findBranchPr, findPrByRef } from "./find";
export * from "./types";

const log = logger.child({ component: "hub/pr" });
const THREADS_TTL = "30 seconds";

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
        return findPrByRef({ ref: options.pr, runner: options.runner, readFacts: options.readFacts });
    }

    const found = await findBranchPr(options);

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

    const api = await resolveProjectApi({ host: gitlabBaseUrl(pr), project: pr.project });
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

/** Threads for the window, from a 30 s cache per PR unless `noCache` (the window may poll while open). */
export async function prThreads({
    pr,
    backend,
    noCache = false,
    storage = cacheStorage(),
}: {
    pr: FoundPr;
    backend: PrBackend;
    noCache?: boolean;
    storage?: Storage;
}): Promise<ThreadsResult> {
    const key = cacheKey(pr);

    if (!noCache) {
        const hit = await storage.getCacheFile<ThreadsResult>(key, THREADS_TTL);

        if (hit && hit.pr.headSha === pr.headSha) {
            log.debug({ key }, "hub pr threads: cache hit");
            return { ...hit, pr, cached: true };
        }
    }

    const fresh = await backend.threads();
    const result: ThreadsResult = { pr, ...fresh, cached: false, fetchedAt: new Date().toISOString() };
    await storage.putCacheFile(key, result, THREADS_TTL);
    log.debug({ key, threads: result.threads.length, drafts: result.draftCount }, "hub pr threads: fetched");
    return result;
}

/** A write changed what `threads` returns; the next read must not serve the old answer. */
export async function forgetThreads({ pr, storage = cacheStorage() }: { pr: FoundPr; storage?: Storage }) {
    await storage.deleteCacheFile(cacheKey(pr));
}
