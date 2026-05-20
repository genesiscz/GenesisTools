/**
 * Single source of truth for `az login` recommendations across the codebase.
 *
 * Two canonical commands:
 *   1. **Primary** — device-code flow with `--allow-no-subscriptions`. Works
 *      for most accounts; no browser session needed; tolerates accounts with
 *      no Azure subscriptions in the tenant (common in enterprise setups
 *      where the user has tenant-level access only).
 *   2. **Fallback** — interactive browser with the Azure DevOps OAuth scope.
 *      Required on tenants whose Conditional Access policy blocks the
 *      device-code flow (returns `AADSTS530036`).
 *
 * Both commands gain `--tenant "<id>"` when a tenant UUID can be extracted
 * from the failing `az` stderr.
 *
 * Use the helpers below instead of hand-rolling the strings — keeps the
 * recommendations consistent everywhere they surface (error throws, auth
 * guide banner, README cross-links).
 */

/** Azure DevOps' well-known OAuth resource ID. Used in `--scope <id>/.default`. */
export const AZURE_DEVOPS_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

export interface AzLoginCommandOptions {
    /** Optional tenant UUID to embed in the commands (when known). */
    tenant?: string;
}

function tenantArg(opts: AzLoginCommandOptions): string {
    return opts.tenant ? ` --tenant "${opts.tenant}"` : "";
}

/** Device-code flow. Recommended default. */
export function azLoginPrimaryCommand(opts: AzLoginCommandOptions = {}): string {
    return `az login${tenantArg(opts)} --allow-no-subscriptions --use-device-code`;
}

/** Browser flow with the Azure DevOps scope. Fallback for Conditional-Access-locked tenants. */
export function azLoginFallbackCommand(opts: AzLoginCommandOptions = {}): string {
    return `az login${tenantArg(opts)} --scope ${AZURE_DEVOPS_RESOURCE_ID}/.default --allow-no-subscriptions`;
}

/**
 * Multi-line block listing both commands with the "if that doesn't work" hint.
 * Suitable for error messages, throws, and CLI banners.
 *
 * @param indent String prepended to each command line. Default `"  "` (two
 *               spaces) — matches the visual style of nested CLI hints.
 */
export function azLoginSuggestionBlock(opts: AzLoginCommandOptions & { indent?: string } = {}): string {
    const indent = opts.indent ?? "  ";
    const primary = azLoginPrimaryCommand(opts);
    const fallback = azLoginFallbackCommand(opts);
    return `${indent}${primary}\n${indent}If that doesn't work (AADSTS530036 etc.), use:\n${indent}${fallback}`;
}

/**
 * Extract a tenant UUID from an `az login` failure's stderr if one is
 * mentioned (typically `... --tenant b233f9e1-...`).
 *
 * Returns null when no tenant hint is present — callers fall back to the
 * tenant-less form.
 */
export function extractTenantFromStderr(stderr: string): string | null {
    const match = stderr.match(/--tenant\s+"?([0-9a-fA-F-]{36})"?/);
    return match?.[1] ?? null;
}
