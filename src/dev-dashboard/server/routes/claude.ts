import { type AiAggregator, defaultAiAggregator } from "@app/dev-dashboard/lib/ai-accounts/aggregator";
import { aiHandlers } from "@app/dev-dashboard/server/routes/ai";
import type { RouteDef } from "@app/dev-dashboard/server/types";

/** Anthropic's plugin id. Every alias below pins its query to it (spec 9.1). */
const ANTHROPIC_SUB = "anthropic-sub";

const DEFAULT_ALIAS_MINUTES = 1440;

/** `minutes` back from now. The upper bound is exclusive, hence `now + 1ms`. */
function windowFromMinutes(minutes: number, now = Date.now()): { from: string; to: string } {
    return { from: new Date(now - minutes * 60_000).toISOString(), to: new Date(now + 1).toISOString() };
}

function parseMinutes(raw: string | null): number {
    const minutes = Number.parseInt(raw ?? String(DEFAULT_ALIAS_MINUTES), 10);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_ALIAS_MINUTES;
}

/**
 * The Claude-only paths, kept for bookmarks and any client that predates
 * `/api/ai/*`. Each one is the multi-provider handler with the query pinned to
 * anthropic, so there is no second implementation that can drift. The bodies are
 * the NEW envelopes: an `rg` on 2026-09-04 found no in-tree consumer of the old
 * ones, and the Claude-only page they served is gone (plan risks 4 and 5).
 */
export function claudeRoutes(agg: AiAggregator = defaultAiAggregator()): RouteDef[] {
    const h = aiHandlers(agg);

    return [
        {
            method: "GET",
            pattern: "/api/claude/usage",
            handler: () => h.usage({ providers: [ANTHROPIC_SUB] }),
        },
        {
            method: "GET",
            pattern: "/api/claude/usage/totals",
            handler: (ctx) => {
                const window = windowFromMinutes(parseMinutes(ctx.query.get("minutes")));
                return h.spendTotals({ ...window, source: "calls" });
            },
        },
        {
            method: "GET",
            pattern: "/api/claude/usage/history",
            handler: (ctx) => {
                const account = ctx.query.get("account");
                const buckets = ctx.query.get("buckets") ?? ctx.query.get("bucket");
                const window = windowFromMinutes(parseMinutes(ctx.query.get("minutes")));

                return h.usageSeries({
                    ...window,
                    providers: [ANTHROPIC_SUB],
                    accounts: account ? [account] : [],
                    keys: buckets
                        ? buckets
                              .split(",")
                              .map((bucket) => bucket.trim())
                              .filter(Boolean)
                        : [],
                });
            },
        },
    ];
}
