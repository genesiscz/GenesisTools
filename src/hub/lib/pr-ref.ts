/** A PR or MR page, as `HubPRRef.fromPageURL` reads it: `…/owner/repo/pull/42`, `…/group/app/-/merge_requests/12`. */
const PR_PAGE = /^https?:\/\/[^/]+\/(?:[^/]+\/)+(?:pull|-\/merge_requests)\/\d+(?:[/?#].*)?$/;

/**
 * What the hub's `--pr` takes (`HubPRRef` in Sources/Hub/HubPRs.swift, and `tools hub --pr`): `42`, `#42`,
 * `owner/repo#42`, `group/app!12`, or a PR or MR page URL. Anything else the hub drops silently and opens
 * without a selection, so every producer of a `--pr` value (the CLI flag, a notification click) checks it here first.
 */
export function isHubPrRef(ref: string): boolean {
    const text = ref.trim();
    return /^(?:.*[#!])?\d+$/.test(text) || PR_PAGE.test(text);
}

/**
 * What the hub's `--commit` takes (`HubCommitSpan` in Sources/Parts/Hub/Hub/HubCommitLink.swift): 7 to 40 hex
 * characters, a prefix of the sha, or `<from>..<to>`, a run of commits with both ends included.
 */
export function isHubCommitSha(sha: string): boolean {
    return /^[0-9a-f]{7,40}(?:\.\.[0-9a-f]{7,40})?$/i.test(sha.trim());
}

/** Why `tools hub open`'s `--commit` / `--repo` cannot open as given; undefined when they can or are absent. */
export function commitFlagsProblem({
    commit,
    repo,
    pr,
}: {
    commit?: string;
    repo?: string;
    pr?: string;
}): string | undefined {
    if (commit !== undefined && !isHubCommitSha(commit)) {
        return `--commit takes a sha of 7 to 40 hex characters, or <from>..<to>, got ${commit}`;
    }

    if (repo !== undefined && pr !== undefined) {
        return "--repo names the project of a commit that has no PR; with --pr the PR names it, so pass one of them";
    }

    if (repo !== undefined && commit === undefined) {
        return "--repo names the project of one commit: pass --commit too (or --worktree to open a checkout)";
    }

    if (commit !== undefined && pr === undefined && repo === undefined) {
        return "--commit needs the PR it is in (--pr) or its project (--repo <path|owner/repo>)";
    }

    return undefined;
}
