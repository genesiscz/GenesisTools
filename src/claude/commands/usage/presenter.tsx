import { colorForPctWithReset } from "@app/claude/lib/usage/constants";
import type { AccountUsageSnapshot, UsagePresenters } from "@genesiscz/utils/ai/providers/account-features";
import { snapshotToAccountUsage } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/usage";
import { AccountSection, estimateAccountHeight, MIN_ACCOUNT_COLUMN_WIDTH } from "./components/overview/account-section";
import { applySort } from "./components/overview/overview-sort";

/**
 * The anthropic-sub half of the usage TUI (spec section 7.3).
 *
 * The shell speaks `AccountUsageSnapshot`; every claude-specific renderer here still
 * speaks `AccountUsage`, so this module is the one place the two meet. `snapshot.native`
 * is the raw `UsageResponse` the plugin's poll always attaches, which makes the
 * conversion lossless rather than a re-derivation from `LimitWindow[]`.
 *
 * It lives in the command folder, not on the plugin object: these are React components,
 * and hanging them off `accounts.usage.presenters` would pull Ink into every
 * `tools ai config` call that only wants to read an account.
 */

export const anthropicPresenters: UsagePresenters = {
    AccountSection({ snapshot, width, prominent }) {
        return <AccountSection account={snapshotToAccountUsage(snapshot)} prominentBuckets={prominent} width={width} />;
    },

    /** The same grouped-urgency order `tools claude run`'s account picker uses. */
    score(snapshots) {
        const byName = new Map(snapshots.map((s) => [s.accountName, s]));

        return applySort(snapshots.map(snapshotToAccountUsage), "urgency")
            .map((account) => byName.get(account.accountName))
            .filter((snapshot): snapshot is AccountUsageSnapshot => snapshot !== undefined);
    },

    estimateHeight(snapshot, { width, prominent }) {
        return estimateAccountHeight(snapshotToAccountUsage(snapshot), prominent, width);
    },

    minColumnWidth: MIN_ACCOUNT_COLUMN_WIDTH,

    /** A bucket about to refill reads green even when it is spent. */
    colorFor(window, now) {
        return colorForPctWithReset(window.percentUsed, window.key, window.resetsAt ?? null, new Date(now));
    },

    // Read off `sessions-view.tsx`, not off the old overlay: the view binds `f`, and
    // Enter opens a menu rather than resuming straight away.
    helpLines: [
        ["", "Sessions tab:"],
        ["↑/↓", "Select session"],
        ["Enter", "Open action menu (ping / copy resume)"],
        ["f", "Cycle time filter (1h/6h/24h/7d/all)"],
        ["j/k", "Scroll list"],
        ["g/G", "Top/bottom"],
    ],
};
