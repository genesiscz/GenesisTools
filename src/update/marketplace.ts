export const MARKETPLACE_NAME = "genesis-tools";
/** Only used when this process cannot find a real checkout to point the marketplace at. */
export const MARKETPLACE_FALLBACK_SOURCE = "https://github.com/genesiscz/GenesisTools";
export const PLUGIN_REF = "genesis-tools@genesis-tools";

export interface MarketplaceEntry {
    name?: string;
    source?: "directory" | "git" | "github";
    /** Present for directory sources. */
    path?: string;
}

/**
 * Three states, not two. `claude plugin marketplace list --json` failing is NOT the
 * same fact as the marketplace being absent, and conflating them makes a transient
 * CLI error re-run `marketplace add`, which overwrites a perfectly good registration.
 */
export type MarketplaceLookup =
    | { status: "found"; entry: MarketplaceEntry }
    | { status: "absent" }
    | { status: "unknown" };

export type MarketplaceAction = "add-checkout" | "add-fallback" | "refresh";

export interface MarketplacePlan {
    action: MarketplaceAction;
    /** True when an ALREADY-registered marketplace is being re-sourced (git-clone → this-repo flip). */
    repointed: boolean;
    /** Printed before acting when the plan had to be defensive about missing information. */
    reason?: string;
}

function pointsAtCheckout(entry: MarketplaceEntry, checkout: string, resolvePath: (p: string) => string): boolean {
    return entry.source === "directory" && entry.path !== undefined && resolvePath(entry.path) === checkout;
}

/**
 * Decide what to do with the marketplace registration. Pure so the decision is testable
 * without a `claude` binary — every branch here either mutates the user's plugin setup or
 * deliberately declines to.
 */
export function planMarketplaceAction(args: {
    isCheckout: boolean;
    /** Already absolute-resolved. */
    checkout: string;
    lookup: MarketplaceLookup;
    resolvePath: (p: string) => string;
}): MarketplacePlan {
    const { isCheckout, checkout, lookup, resolvePath } = args;

    if (lookup.status === "unknown") {
        // Absence was never established, so `add` (which overwrites) is off the table.
        return {
            action: "refresh",
            repointed: false,
            reason: "Could not read the marketplace list; leaving the existing registration alone.",
        };
    }

    if (isCheckout) {
        if (lookup.status === "found" && pointsAtCheckout(lookup.entry, checkout, resolvePath)) {
            return { action: "refresh", repointed: false };
        }

        return { action: "add-checkout", repointed: lookup.status === "found" };
    }

    if (lookup.status === "absent") {
        return { action: "add-fallback", repointed: false };
    }

    return { action: "refresh", repointed: false };
}
