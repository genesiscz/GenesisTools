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
