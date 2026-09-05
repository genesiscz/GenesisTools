import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { logger } from "@genesiscz/utils/logger";
import type { AccountEntry } from "../../../config/schema";
import type {
    AccountUsageFeature,
    AccountUsageSnapshot,
    LimitSeverity,
    LimitWindow,
    UsagePollOptions,
} from "../../account-features";
import type { AccountUsage, UsageResponse } from "./api";
import { ANTHROPIC_SUB, pollAccount } from "./api";
import { BUCKET_LABELS, BUCKET_PERIODS_MS, bucketKind } from "./buckets";
import type { Severity } from "./limits";
import { normalizeLimits, normalizeSpend } from "./limits";

/**
 * `accounts.usage` for the Claude Max/Pro subscription (spec 2026-09-04 section 4.2).
 *
 * The poll core (`usage-poll/poll.ts`) owns the failure gate, the 45s shared cache and the
 * write-through, so this module only turns ONE account into ONE snapshot. Everything that
 * is anthropic-specific stays here: the plan gate, the 5-requests-per-access-token 429
 * unlock (`api.ts`), and the bucket vocabulary.
 */

const SEVERITY_MAP: Record<Severity, LimitSeverity> = {
    normal: "ok",
    warning: "warn",
    critical: "critical",
};

/** Anthropic refreshes usage often and the daemon is the driver; keep the 30s default. */
const MIN_INTERVAL_MS = 30_000;

function labelFor(bucket: string, scopeModel: string | null): string {
    return BUCKET_LABELS[bucket] ?? (scopeModel ? `Weekly (${scopeModel})` : bucket);
}

/**
 * `UsageResponse` to provider-neutral windows. `normalizeLimits` already collapses the
 * API's `session` / `weekly_all` / `weekly_scoped` kinds onto bucket keys; the kind written
 * here is the amended mapping (session -> session, weekly_all -> weekly, weekly_scoped ->
 * scoped), and the spend bucket becomes one `credit` window carrying money.
 */
export function toLimitWindows(usage: UsageResponse): LimitWindow[] {
    const windows: LimitWindow[] = [];

    for (const limit of normalizeLimits(usage)) {
        if (typeof limit.percent !== "number" || !Number.isFinite(limit.percent)) {
            continue;
        }

        windows.push({
            key: limit.bucket,
            label: labelFor(limit.bucket, limit.scope_model),
            kind: limit.scope_model ? "scoped" : bucketKind(limit.bucket),
            percentUsed: limit.percent,
            severity: SEVERITY_MAP[limit.severity],
            isActive: limit.is_active,
            ...(limit.scope_model ? { scopeModel: limit.scope_model } : {}),
            ...(limit.resets_at ? { resetsAt: limit.resets_at } : {}),
            ...(BUCKET_PERIODS_MS[limit.bucket] ? { periodMs: BUCKET_PERIODS_MS[limit.bucket] } : {}),
        });
    }

    const spend = normalizeSpend(usage);

    if (spend) {
        windows.push({
            key: "extra_usage",
            label: BUCKET_LABELS.extra_usage,
            kind: "credit",
            percentUsed: spend.percent,
            severity: SEVERITY_MAP[spend.severity],
            isActive: spend.enabled,
            money: {
                usedMinor: spend.used_minor,
                currency: spend.used_currency,
                exponent: spend.used_exponent,
                ...(spend.limit_minor === null ? {} : { limitMinor: spend.limit_minor }),
            },
        });
    }

    return windows;
}

/** Identity and login-health fields the TUI, the dashboard and Genesis all read. */
function snapshotBase(account: AccountEntry, usage: AccountUsage, fetchedAt: string): AccountUsageSnapshot {
    const auth: AccountUsageSnapshot["auth"] = {};

    // Built once and range-checked: `refreshExpiresAt` reaches here straight off the
    // account file, and `toISOString()` throws RangeError on a value a Date cannot hold.
    // The inverse projection below already guards the same field.
    const refreshExpiresAt = usage.refreshExpiresAt === undefined ? null : new Date(usage.refreshExpiresAt);

    if (refreshExpiresAt && !Number.isNaN(refreshExpiresAt.getTime())) {
        auth.refreshExpiresAt = refreshExpiresAt.toISOString();
    }

    if (usage.orgBlocked) {
        auth.orgBlocked = true;
    }

    return {
        provider: ANTHROPIC_SUB,
        accountId: account.id,
        accountName: account.name,
        fetchedAt,
        limits: [],
        ...(account.label === undefined ? {} : { label: account.label }),
        plan: {
            ...(usage.subscriptionPlan === undefined ? {} : { name: usage.subscriptionPlan }),
            ...(usage.subscriptionStatus === undefined ? {} : { status: usage.subscriptionStatus }),
            ...(usage.subscriptionCreatedAt === undefined ? {} : { createdAt: usage.subscriptionCreatedAt }),
            ...(usage.planContradictedAt === undefined ? {} : { contradictedAt: usage.planContradictedAt }),
        },
        ...(Object.keys(auth).length > 0 ? { auth } : {}),
    };
}

/**
 * The v3 entry `pollAccount` still takes. Looked up by NAME, which is what the legacy
 * facade keys on; a v4 account whose provider is not `anthropic-sub` never reaches here
 * because `pollAccounts` filters by provider first.
 */
async function legacyEntryFor(account: AccountEntry): Promise<{ entry: AIAccountEntry; config: AIConfig }> {
    const config = await AIConfig.load();
    const entry = config.getAccountsByProvider(ANTHROPIC_SUB).find((candidate) => candidate.name === account.name);

    if (!entry) {
        throw new Error(`Account "${account.name}" is not in the AI config`);
    }

    return { entry, config };
}

export async function pollAnthropicAccount(
    account: AccountEntry,
    opts: UsagePollOptions = {}
): Promise<AccountUsageSnapshot> {
    const fetchedAt = new Date().toISOString();
    const { entry, config } = await legacyEntryFor(account);

    // An empty gate on purpose: the poll core already refused every account the gate
    // blocks, so re-reading it here would only make the backoff decision twice.
    const usage = await pollAccount({
        account: entry,
        config,
        gate: {},
        now: Date.now(),
        ...(opts.probe === undefined ? {} : { probe: opts.probe }),
        ...(opts.orgBlocked === undefined ? {} : { orgBlocked: opts.orgBlocked }),
    });

    const snapshot = snapshotBase(account, usage, fetchedAt);

    if (!usage.usage) {
        logger.debug({ account: account.name }, "[usage] anthropic poll returned no usage payload");
        return { ...snapshot, error: usage.error ?? "no usage payload" };
    }

    return {
        ...snapshot,
        limits: toLimitWindows(usage.usage),
        // The legacy `usage-shared` projection the Genesis app reads is built from this,
        // and so is the anthropic TUI presenter. It must always be set.
        native: usage.usage,
    };
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

    return {
        accountName: snapshot.accountName,
        ...(snapshot.label === undefined ? {} : { label: snapshot.label }),
        ...(snapshot.plan?.createdAt === undefined ? {} : { subscriptionCreatedAt: snapshot.plan.createdAt }),
        ...(snapshot.plan?.name === undefined ? {} : { subscriptionPlan: snapshot.plan.name }),
        ...(snapshot.plan?.status === undefined ? {} : { subscriptionStatus: snapshot.plan.status }),
        ...(snapshot.plan?.contradictedAt === undefined ? {} : { planContradictedAt: snapshot.plan.contradictedAt }),
        ...(refreshExpiresAt === undefined || Number.isNaN(refreshExpiresAt) ? {} : { refreshExpiresAt }),
        ...(snapshot.native === undefined ? {} : { usage: snapshot.native as UsageResponse }),
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

export const anthropicUsage: AccountUsageFeature = {
    poll: pollAnthropicAccount,
    minIntervalMs: MIN_INTERVAL_MS,
};
