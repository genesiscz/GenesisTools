import { type ExecResult, Executor } from "@genesiscz/utils/cli";
import { classifyOriginUrl, type OriginKind } from "@genesiscz/utils/git/origins";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "hub/pr-fetch" });

/** One fetch is one network call; the hub waits on it with a visible state, so it must end. */
export const PR_FETCH_TIMEOUT_MS = 40_000;
/** Everything this verb writes lives under here: never a branch, a tag or a remote-tracking ref. */
export const PR_REF_NAMESPACE = "refs/genesis/pr";
export const PR_FETCH_PROVIDERS: readonly OriginKind[] = ["github", "gitlab"];

export type PrFetchErrorCode =
    | "not-a-repo"
    | "no-remote"
    | "unsupported-host"
    | "ref-missing"
    | "auth"
    | "network"
    | "git";

/** A failure the hub shows as one sentence with a retry: `--json` prints `{ error, code }`. */
export class PrFetchError extends Error {
    constructor(
        readonly code: PrFetchErrorCode,
        message: string
    ) {
        super(message);
    }
}

export interface PrFetchInput {
    /** A folder inside the checkout whose `remote` is the PR's project. */
    repo: string;
    number: number;
    /** The head the caller expects (the PR list's `headSha`): when it is already local, nothing is fetched. */
    head?: string | null;
    /** The PR's recorded base commit. */
    base?: string | null;
    /** The PR's target branch: fetched when the recorded base is not local, so the merge base is the PR's own. */
    baseBranch?: string | null;
    /** Default: from the remote's URL. */
    provider?: OriginKind | null;
    remote?: string;
    timeoutMs?: number;
}

export interface PrFetchResult {
    repoRoot: string;
    number: number;
    provider: OriginKind;
    remote: string;
    /** The host's ref for the PR head: `refs/pull/<n>/head` or `refs/merge-requests/<iid>/head`. */
    sourceRef: string;
    /** The private ref that holds the head: `refs/genesis/pr/<n>/head`. */
    headRef: string;
    head: string;
    /** A local commit to diff from: the recorded base, else the target branch's tip; null when neither is here. */
    base: string | null;
    /** Set when the target branch was fetched: `refs/genesis/pr/<n>/base`. */
    baseRef: string | null;
    mergeBase: string | null;
    /** false = no network: the private ref or the object store already had the head. */
    fetched: boolean;
    elapsedMs: number;
    warnings: string[];
}

/** The host's own ref for a PR/MR head. It lives on the base project, so a PR from a fork has one too. */
export function prSourceRef(provider: OriginKind, number: number): string {
    return provider === "gitlab" ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`;
}

export function prPrivateRefs(number: number): { head: string; base: string } {
    return { head: `${PR_REF_NAMESPACE}/${number}/head`, base: `${PR_REF_NAMESPACE}/${number}/base` };
}

/** What a failed `git fetch` means, from its stderr; the message is the sentence the hub shows. */
export function classifyFetchError({
    stderr,
    remote,
    ref,
}: {
    stderr: string;
    remote: string;
    ref: string;
}): PrFetchError {
    const text = stderr.toLowerCase();
    const detail = stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? "";

    if (text.includes("couldn't find remote ref") || text.includes("could not find remote ref")) {
        return new PrFetchError(
            "ref-missing",
            `${remote} has no ${ref}: the PR/MR is gone, or the host removed its ref`
        );
    }

    if (
        /authentication failed|permission denied|could not read (username|password)|terminal prompts disabled|access denied|http basic|\b40[13]\b|repository not found|host key verification failed/.test(
            text
        )
    ) {
        return new PrFetchError(
            "auth",
            `${remote} refused the fetch (${detail}); run \`git fetch ${remote}\` in a terminal to sign in`
        );
    }

    if (
        /could not resolve host|connection (refused|timed out|reset)|operation timed out|network is unreachable|unable to access|timed out after|early eof|the remote end hung up/.test(
            text
        )
    ) {
        return new PrFetchError("network", `could not reach ${remote} (${detail})`);
    }

    return new PrFetchError("git", `git fetch ${remote} ${ref} failed: ${detail || "no error text"}`);
}

/**
 * Puts a PR/MR head into the checkout without a checkout: `git fetch <remote> <pr ref>` into
 * `refs/genesis/pr/<n>/head`, and the target branch into `.../base` when the recorded base is not local.
 * No branch, tag, remote-tracking ref, FETCH_HEAD or working tree changes. Once per head: when the
 * private ref or the object store already has `head`, there is no network call.
 */
export async function fetchPrHead(input: PrFetchInput): Promise<PrFetchResult> {
    const started = performance.now();
    const git = new Executor({ prefix: "git", cwd: input.repo, env: { GIT_TERMINAL_PROMPT: "0" } });
    const remote = input.remote ?? "origin";
    const timeout = input.timeoutMs ?? PR_FETCH_TIMEOUT_MS;
    const warnings: string[] = [];

    // A folder that does not exist fails the spawn itself (ENOENT on the cwd), not git.
    const top = await git
        .exec(["rev-parse", "--path-format=absolute", "--show-toplevel"])
        .catch((error: unknown): null => {
            log.debug({ error, repo: input.repo }, "hub pr fetch: git could not start in the folder");
            return null;
        });

    if (!top?.success) {
        throw new PrFetchError("not-a-repo", `not a git checkout: ${input.repo}`);
    }

    const repoRoot = top.stdout;
    const url = await git.exec(["remote", "get-url", remote]);

    if (!url.success || !url.stdout) {
        throw new PrFetchError("no-remote", `${repoRoot} has no remote "${remote}"`);
    }

    const provider = input.provider ?? classifyOriginUrl(url.stdout).kind;

    if (!provider) {
        throw new PrFetchError(
            "unsupported-host",
            `${remote} (${url.stdout}) is not a GitHub or GitLab project; pass --provider github|gitlab`
        );
    }

    const sourceRef = prSourceRef(provider, input.number);
    const refs = prPrivateRefs(input.number);

    const commit = async (rev: string): Promise<string | null> => {
        const res = await git.exec(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
        return res.success && res.stdout ? res.stdout : null;
    };

    // `--refmap=` keeps a `refs/heads/*` source from also moving the remote-tracking branch.
    const fetch = async (source: string, destination: string): Promise<void> => {
        const args = [
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            "--refmap=",
            remote,
            `+${source}:${destination}`,
        ];
        log.debug({ repoRoot, remote, source, destination }, "hub pr fetch: git fetch");
        let res: ExecResult;

        try {
            res = await git.exec(args, { timeout });
        } catch (error) {
            log.warn({ error, repoRoot, source }, "hub pr fetch: git fetch did not run to the end");
            const timedOut = error instanceof Error && error.message.includes("timed out");
            throw new PrFetchError(
                timedOut ? "network" : "git",
                timedOut
                    ? `git fetch ${remote} ${source} did not finish within ${timeout / 1000} s`
                    : `git fetch could not start: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        if (!res.success) {
            log.warn(
                { repoRoot, source, stderr: res.stderr, exitCode: res.exitCode },
                "hub pr fetch: git fetch failed"
            );
            throw classifyFetchError({ stderr: res.stderr, remote, ref: source });
        }
    };

    let fetched = false;
    const pinned = await commit(refs.head);
    const wanted = input.head ? await commit(input.head) : null;

    if (wanted && pinned === wanted) {
        log.debug({ repoRoot, number: input.number, head: wanted }, "hub pr fetch: head already pinned");
    } else if (wanted) {
        // The commit is here already (a fetched branch, an earlier fetch): pinning it needs no network.
        const pin = await git.exec(["update-ref", refs.head, wanted]);

        if (!pin.success) {
            throw new PrFetchError("git", `git update-ref ${refs.head} failed: ${pin.stderr}`);
        }
    } else {
        await fetch(sourceRef, refs.head);
        fetched = true;
    }

    const head = await commit(refs.head);

    if (!head) {
        throw new PrFetchError("git", `${refs.head} names no commit after the fetch`);
    }

    if (input.head && !head.startsWith(input.head) && !input.head.startsWith(head)) {
        warnings.push(`the host's head is ${head.slice(0, 10)}, not ${input.head.slice(0, 10)}: the PR moved`);
    }

    let base = input.base ? await commit(input.base) : null;
    let baseRef: string | null = null;

    if (!base && input.baseBranch) {
        try {
            await fetch(`refs/heads/${input.baseBranch}`, refs.base);
            fetched = true;
            baseRef = refs.base;
            // The recorded base usually comes with its branch; its tip is the fallback.
            base = (input.base ? await commit(input.base) : null) ?? (await commit(refs.base));
        } catch (error) {
            if (!(error instanceof PrFetchError)) {
                throw error;
            }

            warnings.push(`the target branch ${input.baseBranch} could not be fetched: ${error.message}`);
        }
    }

    if (!base) {
        warnings.push(
            input.base
                ? `the recorded base ${input.base.slice(0, 10)} is not in ${repoRoot}`
                : "no base: pass --base or --base-branch"
        );
    }

    let mergeBase: string | null = null;

    if (base) {
        const res = await git.exec(["merge-base", base, head]);
        mergeBase = res.success && res.stdout ? res.stdout : null;

        if (!mergeBase) {
            warnings.push(`${base.slice(0, 10)} and ${head.slice(0, 10)} share no history`);
        }
    }

    const elapsedMs = Math.round(performance.now() - started);
    log.info(
        { repoRoot, number: input.number, provider, head, base, mergeBase, fetched, elapsedMs, warnings },
        "hub pr fetch"
    );
    return {
        repoRoot,
        number: input.number,
        provider,
        remote,
        sourceRef,
        headRef: refs.head,
        head,
        base,
        baseRef,
        mergeBase,
        fetched,
        elapsedMs,
        warnings,
    };
}
