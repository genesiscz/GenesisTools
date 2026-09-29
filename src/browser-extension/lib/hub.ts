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
    options: Pick<OpenHubOptions, "mode" | "pr" | "reveal" | "worktree">;
    root: string;
    /** One line for the result card: what opens. */
    summary: string;
}

/**
 * A PR or MR page selects that PR in the hub's PRs mode (a diff file also opens in its review);
 * any other page of a project opens the Worktrees mode on the checkout it resolves to. The hub
 * lists the PRs of local checkouts only, so the checkout is resolved first: without one there is
 * nothing the hub could select, and the caller gets `no-checkout` with the reason.
 */
export async function hubTarget(deps: Deps, request: HubRequest): Promise<HubTarget> {
    const { page, checkout } = await resolveRequest(deps, request);

    if (page.view === "pr" && page.number !== undefined) {
        const pr = `${page.project}${page.kind === "gitlab" ? "!" : "#"}${page.number}`;
        const given = request.path !== undefined && request.path !== null && request.path !== "";
        const reveal = given ? checkRelativePath(request.path) : undefined;
        return {
            options: { mode: "prs", pr, reveal },
            root: checkout.root,
            summary: reveal ? `${pr}, ${reveal}` : pr,
        };
    }

    return {
        options: { mode: "worktrees", worktree: checkout.root },
        root: checkout.root,
        summary: `the worktree ${checkout.root}${checkout.branch ? ` (${checkout.branch})` : ""}`,
    };
}

export async function openInHub(deps: Deps, request: HubRequest): Promise<{ detail: string; root: string }> {
    const target = await hubTarget(deps, request);
    const opened = await deps.hub(target.options);
    log.info({ ...target.options, root: target.root, args: opened.args }, "opened in the hub");
    return { detail: `GenesisTools shows ${target.summary}`, root: target.root };
}
