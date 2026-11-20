import type { OpenHubOptions } from "@app/hub/lib/open";
import { logger } from "@genesiscz/utils/logger";
import type { Deps } from "./deps";
import { type PageRequest, resolveRequest } from "./open";
import { checkRelativePath } from "./values";

const log = logger.child({ component: "browser-extension/hub" });

export interface HubRequest extends PageRequest {
    /** A repo-relative file of a PR diff; the hub opens it in that PR's review. */
    path?: unknown;
}

/** What "Open in GenesisTools" shows for one page, and the checkout it resolved to. */
export interface HubTarget {
    options: Pick<OpenHubOptions, "mode" | "pr" | "reveal" | "worktree" | "commit" | "repo">;
    root: string;
    /** One line for the result card: what opens. */
    summary: string;
}

/** The budget of all fetches for one commit page; the host's `hub.open` reply has 60 s. */
const FETCH_TIMEOUT_MS = 30_000;

const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * The full id of the one commit that starts with `prefix`, or undefined when none or several do. `--disambiguate`
 * lists object ids only, so a branch or tag that happens to be named like the prefix cannot win.
 */
async function commitForPrefix(deps: Deps, root: string, prefix: string): Promise<string | undefined> {
    const listed = await deps.run(["git", "-C", root, "rev-parse", `--disambiguate=${prefix}`], { timeoutMs: 5_000 });

    if (listed.code !== 0) {
        return undefined;
    }

    const commits: string[] = [];

    for (const id of listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)) {
        const kind = await deps.run(["git", "-C", root, "cat-file", "-t", id], { timeoutMs: 5_000 });

        if (kind.code === 0 && kind.stdout.trim() === "commit") {
            commits.push(id);
        }
    }

    return commits.length === 1 ? commits[0] : undefined;
}

type CommitState = { state: "present" | "fetched"; sha: string } | { state: "missing" };

/**
 * The hub shows only a commit that is in the checkout, and a commit page often names one this Mac has not fetched
 * yet (a teammate's push), so a miss fetches from origin: the commit itself when the page gave a full id (a
 * single-branch checkout does not track the branch that holds it), then every branch as a bounded fallback.
 * `missing` when even that did not bring it: a commit on no branch of origin, or fetches that failed (logged with
 * their stderr). A failed fetch can still have downloaded the commit, so every attempt is followed by a new lookup.
 */
async function ensureCommit(deps: Deps, root: string, sha: string): Promise<CommitState> {
    const present = await commitForPrefix(deps, root, sha);

    if (present) {
        return { state: "present", sha: present };
    }

    const attempts = FULL_SHA.test(sha) ? [["origin", sha], ["origin"]] : [["origin"]];
    const deadline = Date.now() + FETCH_TIMEOUT_MS;

    for (const refs of attempts) {
        const timeoutMs = deadline - Date.now();

        if (timeoutMs <= 0) {
            break;
        }

        const fetch = await deps.run(["git", "-C", root, "fetch", "--quiet", "--no-write-fetch-head", ...refs], {
            timeoutMs,
        });

        if (fetch.code !== 0) {
            log.warn(
                { root, sha, refs, code: fetch.code, stderr: fetch.stderr.slice(-300) },
                "the fetch for a commit page failed"
            );
        }

        const found = await commitForPrefix(deps, root, sha);

        if (found) {
            return { state: "fetched", sha: found };
        }
    }

    return { state: "missing" };
}

/**
 * A PR or MR page selects that PR in the hub's PRs mode (a diff file also opens in its review, and a PR commit page
 * selects that commit); a commit page opens that commit in the Worktrees diff of the checkout; any other page of a
 * project opens the Worktrees mode on the checkout it resolves to. The hub lists the PRs of local checkouts only, so
 * the checkout is resolved first: without one there is nothing the hub could select, and the caller gets
 * `no-checkout` with the reason. A commit page fetches origin for a commit the checkout lacks only when
 * `fetchMissing` is set (a real open); a preview never changes the checkout.
 */
export async function hubTarget(
    deps: Deps,
    request: HubRequest,
    { fetchMissing = false }: { fetchMissing?: boolean } = {}
): Promise<HubTarget> {
    const { page, checkout } = await resolveRequest(deps, request);
    const worktree = `the worktree ${checkout.root}${checkout.branch ? ` (${checkout.branch})` : ""}`;

    if (page.view === "pr" && page.number !== undefined) {
        const pr = `${page.project}${page.kind === "gitlab" ? "!" : "#"}${page.number}`;
        const given = request.path !== undefined && request.path !== null && request.path !== "";
        const reveal = given ? checkRelativePath(request.path) : undefined;
        return {
            options: { mode: "prs", pr, reveal, ...(page.commit ? { commit: page.commit } : {}) },
            root: checkout.root,
            summary: [pr, page.commit?.slice(0, 10), reveal].filter(Boolean).join(", "),
        };
    }

    if (page.view === "commit" && page.commit) {
        const short = page.commit.slice(0, 10);

        if (!fetchMissing) {
            const known = await commitForPrefix(deps, checkout.root, page.commit);

            return {
                options: { commit: known ?? page.commit, repo: checkout.root },
                root: checkout.root,
                summary: known
                    ? `commit ${short} in ${checkout.root}`
                    : `commit ${short} in ${checkout.root} (not in it yet; opening fetches origin first)`,
            };
        }

        const found = await ensureCommit(deps, checkout.root, page.commit);

        if (found.state !== "missing") {
            return {
                options: { commit: found.sha, repo: checkout.root },
                root: checkout.root,
                summary: `commit ${short} in ${checkout.root}${found.state === "fetched" ? " (fetched from origin first)" : ""}`,
            };
        }

        return {
            options: { mode: "worktrees", worktree: checkout.root },
            root: checkout.root,
            summary: `${worktree}: commit ${short} is not in it, even after git fetch origin`,
        };
    }

    return { options: { mode: "worktrees", worktree: checkout.root }, root: checkout.root, summary: worktree };
}

export async function openInHub(deps: Deps, request: HubRequest): Promise<{ detail: string; root: string }> {
    const target = await hubTarget(deps, request, { fetchMissing: true });
    const opened = await deps.hub(target.options);
    log.info({ ...target.options, root: target.root, args: opened.args }, "opened in the hub");
    // "Asked", not "shows": the hub answers that it got the request, not that it found the target.
    return { detail: `Asked GenesisTools to show ${target.summary}`, root: target.root };
}
