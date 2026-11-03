import type { AccountUsageSnapshot, LimitKind } from "@genesiscz/utils/ai/providers/account-features";

/** One window of a round worth judging against a threshold. */
export interface NotifiableWindow {
    /** Plugin id. */
    provider: string;
    accountId: string;
    accountName: string;
    key: string;
    kind: LimitKind;
    label: string;
    utilization: number;
    resetsAt: string | null;
}

/**
 * Every window worth a threshold alert, flattened out of a round. The daemon's alert engine and the TUI's in-app
 * alerts both read it; each kept its own copy before.
 *
 * Stale snapshots replay an older fetch and error rows carry nothing, so both are skipped: alerting on a replay
 * re-fires a threshold that was already handled once.
 */
export function notifiableWindows(snapshots: readonly AccountUsageSnapshot[]): NotifiableWindow[] {
    const out: NotifiableWindow[] = [];

    for (const snapshot of snapshots) {
        if (snapshot.stale || snapshot.error) {
            continue;
        }

        for (const window of snapshot.limits) {
            if (typeof window.percentUsed !== "number" || !Number.isFinite(window.percentUsed)) {
                continue;
            }

            out.push({
                provider: snapshot.provider,
                accountId: snapshot.accountId,
                accountName: snapshot.accountName,
                key: window.key,
                kind: window.kind,
                label: window.label,
                utilization: window.percentUsed,
                resetsAt: window.resetsAt ?? null,
            });
        }
    }

    return out;
}
