/**
 * What the hub's `--pr` takes (`HubPRRef` in Sources/Hub/HubPRs.swift, and `tools hub --pr`): `42`, `#42`,
 * `owner/repo#42` or `group/app!12`. Anything else the hub drops silently and opens without a selection,
 * so every producer of a `--pr` value (the CLI flag, a notification click) checks it here first.
 */
export function isHubPrRef(ref: string): boolean {
    return /^(?:.*[#!])?\d+$/.test(ref.trim());
}
