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

/** A fetch of every branch of origin; the host's `hub.open` reply has 60 s. */
const FETCH_TIMEOUT_MS = 30_000;

async function hasCommit(deps: Deps, root: string, sha: string): Promise<boolean> {
    const res = await deps.run(["git", "-C", root, "cat-file", "-e", `${sha}^{commit}`], { timeoutMs: 5_000 });
    return res.code === 0;
}

/**
 * The hub shows only a commit that is in the checkout, and a commit page often names one this Mac has not fetched
 * yet (a teammate's push), so a miss fetches origin once. `missing` when even that did not bring it: a commit on no
 * branch of origin, or a fetch that failed (logged with its stderr).
 */
async function ensureCommit(deps: Deps, root: string, sha: string): Promise<"present" | "fetched" | "missing"> {
    if (await hasCommit(deps, root, sha)) {
        return "present";
    }

    const fetch = await deps.run(["git", "-C", root, "fetch", "--quiet", "origin"], { timeoutMs: FETCH_TIMEOUT_MS });

    if (fetch.code !== 0) {
        log.warn(
            { root, sha, code: fetch.code, stderr: fetch.stderr.slice(-300) },
            "the fetch for a commit page failed"
        );
        return "missing";
    }

    return (await hasCommit(deps, root, sha)) ? "fetched" : "missing";
}

/**
 * A PR or MR page selects that PR in the hub's PRs mode (a diff file also opens in its review, and a PR commit page
 * selects that commit); a commit page opens that commit in the Worktrees diff of the checkout; any other page of a
 * project opens the Worktrees mode on the checkout it resolves to. The hub lists the PRs of local checkouts only, so
 * the checkout is resolved first: without one there is nothing the hub could select, and the caller gets
 * `no-checkout` with the reason.
 */
export async function hubTarget(deps: Deps, request: HubRequest): Promise<HubTarget> {
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
        const state = await ensureCommit(deps, checkout.root, page.commit);

        if (state !== "missing") {
            return {
                options: { commit: page.commit, repo: checkout.root },
                root: checkout.root,
                summary: `commit ${short} in ${checkout.root}${state === "fetched" ? " (fetched from origin first)" : ""}`,
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
    const target = await hubTarget(deps, request);
    const opened = await deps.hub(target.options);
    log.info({ ...target.options, root: target.root, args: opened.args }, "opened in the hub");
    // "Asked", not "shows": the hub answers that it got the request, not that it found the target.
    return { detail: `Asked GenesisTools to show ${target.summary}`, root: target.root };
}
