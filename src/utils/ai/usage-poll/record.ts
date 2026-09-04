import { recordUsage } from "@genesiscz/utils/ai/usage";
import { logger } from "@genesiscz/utils/logger";
import { UsageLimitsDb } from "./limits-db";
import type { AccountUsageSnapshot } from "./types";

/**
 * Write-through from a live poll into the limits store, plus the additive mirror into the
 * call log (`meta.kind = "bucket-snapshot"`). Provider-neutral twin of the anthropic
 * `recordAll` in `src/claude/lib/usage/shared-cache.ts`, which keeps its own path because
 * it also records the anthropic spend row from `normalizeSpend`.
 *
 * Stale snapshots are replays of an older successful fetch: recording them would
 * re-timestamp old utilization as if it were current, so they are skipped.
 */
export async function recordSnapshots(snapshots: readonly AccountUsageSnapshot[], db?: UsageLimitsDb): Promise<void> {
    // No dbPath -> the process-wide ClaudeDatabase singleton, which the daemon holds open.
    const store = db ?? new UsageLimitsDb();
    let written = 0;

    for (const snapshot of snapshots) {
        if (snapshot.stale || snapshot.error) {
            continue;
        }

        for (const window of snapshot.limits) {
            if (typeof window.percentUsed !== "number" || !Number.isFinite(window.percentUsed)) {
                continue;
            }

            // A credit window is also a spend row. `spend_snapshots` predates the
            // provider-neutral windows and is still the money series; recording only the
            // percentage would leave it frozen at whatever the claude-only path last wrote.
            if (window.kind === "credit" && window.money) {
                store.recordSpendIfChanged(
                    snapshot.accountName,
                    {
                        used_minor: window.money.usedMinor,
                        used_currency: window.money.currency,
                        used_exponent: window.money.exponent,
                        limit_minor: window.money.limitMinor ?? null,
                        limit_exponent: window.money.limitMinor === undefined ? null : window.money.exponent,
                        percent: window.percentUsed,
                        severity: window.severity ?? "ok",
                        enabled: window.isActive ?? true,
                        cap_minor: null,
                        cap_currency: null,
                    },
                    snapshot.provider
                );
            }

            const changed = store.recordIfChangedV2(snapshot.accountName, window.key, window.percentUsed, {
                resetsAt: window.resetsAt ?? null,
                severity: window.severity ?? null,
                scopeModel: window.scopeModel ?? null,
                provider: snapshot.provider,
                accountId: snapshot.accountId || null,
                kind: window.kind,
                money: window.money
                    ? {
                          usedMinor: window.money.usedMinor,
                          limitMinor: window.money.limitMinor ?? null,
                          currency: window.money.currency,
                      }
                    : null,
            });

            if (!changed) {
                continue;
            }

            written += 1;

            // Only on a real change. A 30s poll loop mirroring unchanged values would
            // append tens of thousands of identical rows a day to an append-only log.
            void recordUsage({
                app: "ai-usage",
                accountId: snapshot.accountId || snapshot.accountName,
                provider: snapshot.provider,
                modelId: window.scopeModel ?? window.key,
                // A limit window is a percentage, not a token count.
                inputTokens: 0,
                outputTokens: 0,
                meta: {
                    kind: "bucket-snapshot",
                    bucket: window.key,
                    utilization: window.percentUsed,
                    resetsAt: window.resetsAt ?? null,
                    severity: window.severity ?? null,
                },
            });
        }
    }

    logger.debug({ snapshots: snapshots.length, written }, "[usage] snapshot write-through complete");
}
