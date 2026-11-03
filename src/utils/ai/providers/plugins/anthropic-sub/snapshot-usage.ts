import type { AccountUsageSnapshot } from "../../account-features";
import type { AccountUsage, UsageResponse } from "./api";
import { isUsageBucket } from "./api";
import { absentLimitsOf } from "./limits";

/**
 * The previous round's usage payload, when it has the endpoint's shape (a header reading has it too).
 * Keyed on the weekly window, which every account has: an account without a 5-hour limit has
 * `five_hour: null`, and a check on that window dropped every such reading, so no header reading was
 * reused and every 2-minute round asked the Fable model (its 400-a-week probe budget gone in 13 hours).
 */
export function previousUsageOf(snapshot: AccountUsageSnapshot | undefined): UsageResponse | undefined {
    const native = snapshot?.native;

    if (!native || typeof native !== "object" || !("seven_day" in native) || !isUsageBucket(native.seven_day)) {
        return undefined;
    }

    return native as UsageResponse;
}

/**
 * A cached row in the current shape. A build before 2026-11-01 wrote a header reading of an account
 * without a 5-hour limit with a fabricated `{ 0, null }` five_hour window in `limits` and no
 * `absentLimits`; its `native` reading still tells (`fiveHourState`), so the window moves from `limits`
 * to `absentLimits` the way `pollAnthropicAccount` writes it now. A current row is returned unchanged:
 * the poll derives both lists from the same reading, so a row without `absentLimits` has none.
 */
export function upgradeCachedSnapshot(snapshot: AccountUsageSnapshot): AccountUsageSnapshot {
    if (snapshot.absentLimits !== undefined) {
        return snapshot;
    }

    const absentLimits = absentLimitsOf(previousUsageOf(snapshot));

    if (absentLimits.length === 0) {
        return snapshot;
    }

    const absent = new Set(absentLimits.map((limit) => limit.key));

    return { ...snapshot, limits: snapshot.limits.filter((window) => !absent.has(window.key)), absentLimits };
}

/**
 * The inverse of `snapshotBase`: a snapshot back into the `AccountUsage` row every
 * claude-only reader still speaks (`tools claude start`, the doctor, the dev-dashboard
 * aggregator, the TUI presenter). `native` carries the untouched `UsageResponse`, so this
 * is a re-wrap rather than a re-derivation from `LimitWindow[]`.
 */
export function snapshotToAccountUsage(snapshot: AccountUsageSnapshot): AccountUsage {
    const refreshExpiresAt = snapshot.auth?.refreshExpiresAt
        ? new Date(snapshot.auth.refreshExpiresAt).getTime()
        : undefined;
    const { absentLimits } = upgradeCachedSnapshot(snapshot);

    return {
        accountName: snapshot.accountName,
        ...(snapshot.label === undefined ? {} : { label: snapshot.label }),
        ...(snapshot.plan?.createdAt === undefined ? {} : { subscriptionCreatedAt: snapshot.plan.createdAt }),
        // The anchor, not `renewsAt`: that is the projected next charge, and a reader that projects
        // again from it would drift; the signup date is only the fallback when no anchor exists.
        ...(snapshot.plan?.billingAnchor === undefined ? {} : { billingAnchor: snapshot.plan.billingAnchor }),
        ...(snapshot.plan?.name === undefined ? {} : { subscriptionPlan: snapshot.plan.name }),
        ...(snapshot.plan?.status === undefined ? {} : { subscriptionStatus: snapshot.plan.status }),
        ...(snapshot.plan?.contradictedAt === undefined ? {} : { planContradictedAt: snapshot.plan.contradictedAt }),
        ...(refreshExpiresAt === undefined || Number.isNaN(refreshExpiresAt) ? {} : { refreshExpiresAt }),
        ...(snapshot.native === undefined ? {} : { usage: snapshot.native as UsageResponse }),
        ...(absentLimits === undefined ? {} : { absentLimits }),
        ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
        ...(snapshot.stale === undefined
            ? {}
            : {
                  stale: {
                      lastSuccessAt: new Date(snapshot.stale.lastSuccessAt).getTime(),
                      reason: snapshot.stale.reason,
                  },
              }),
        ...(snapshot.auth?.orgBlocked === undefined ? {} : { orgBlocked: snapshot.auth.orgBlocked }),
    };
}
