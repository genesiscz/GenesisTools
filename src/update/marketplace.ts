export const MARKETPLACE_NAME = "genesis-tools";
/** Only used when this process cannot find a real checkout to point the marketplace at. */
export const MARKETPLACE_FALLBACK_SOURCE = "https://github.com/genesiscz/GenesisTools";
export const PLUGIN_REF = "genesis-tools@genesis-tools";

export type PluginStepDecision = "skip" | "run" | "ask";

/**
 * Whether step 4 refreshes the Claude Code plugin, and whether it may ask first.
 *
 * Only a terminal can answer a prompt. Under an agent stdin is /dev/null, and the confirm used to
 * wait there forever (arwen, 2026-10-25), so without a TTY the step takes the prompt's default (yes).
 */
export function pluginStepDecision(opts: {
    hasClaude: boolean;
    plugins: boolean;
    interactive: boolean;
}): PluginStepDecision {
    if (!opts.hasClaude || !opts.plugins) {
        return "skip";
    }

    return opts.interactive ? "ask" : "run";
}

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
    | { status: "found"; entry: MarketplaceEntry; entries?: MarketplaceEntry[] }
    | { status: "absent"; entries?: MarketplaceEntry[] }
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

/** True when the entry is a directory marketplace whose path resolves to this checkout. */
export function marketplacePointsAtCheckout(args: {
    entry: MarketplaceEntry;
    checkout: string;
    resolvePath: (p: string) => string;
}): boolean {
    return pointsAtCheckout(args.entry, args.checkout, args.resolvePath);
}

/**
 * Other marketplaces registered for this same checkout under another name (an old install named it
 * `genesis-tools-plugins`). Claude Code 2.1.305 answers `marketplace add <checkout>` with "Marketplace
 * 'genesis-tools-plugins' already on disk", exits 0 and leaves `genesis-tools` on its git source, so the
 * update re-pointed and reinstalled the plugin on every run. They must go before the add can take effect.
 */
export function blockingMarketplaceAliases(args: {
    entries: MarketplaceEntry[];
    name: string;
    checkout: string;
    resolvePath: (p: string) => string;
}): string[] {
    return args.entries
        .filter((entry) => entry.name !== undefined && entry.name !== args.name)
        .filter((entry) => pointsAtCheckout(entry, args.checkout, args.resolvePath))
        .map((entry) => entry.name ?? "");
}

/** What `claude plugin list --json` says about the plugin. "unknown": the listing failed. */
export type InstalledPlugin = { status: "installed"; version?: string } | { status: "absent" } | { status: "unknown" };

export type PluginAction = "install" | "reinstall" | "update" | "skip";

/**
 * Step 4's plugin work. The plugin is reinstalled only when its source changed (a re-point) or on
 * `--force-plugins`; a plugin already at the checkout's version is left alone, and so is the
 * marketplace refresh, so an update with nothing new runs no claude command at all.
 */
export function planPluginAction(args: {
    installed: InstalledPlugin;
    checkoutVersion: string | undefined;
    repointed: boolean;
    force: boolean;
}): PluginAction {
    const { installed, checkoutVersion, repointed, force } = args;

    if (installed.status === "absent") {
        return "install";
    }

    if (installed.status === "installed" && (repointed || force)) {
        return "reinstall";
    }

    if (installed.status === "installed" && checkoutVersion !== undefined && installed.version === checkoutVersion) {
        return "skip";
    }

    return "update";
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
