import { AI_ACCOUNTS_API } from "@app/dev-dashboard/contract/ai-accounts";
import {
    type AiAggregator,
    defaultAiAggregator,
    type SpendSeriesQuery,
    type SpendTotalsQuery,
    type UsageSeriesQuery,
} from "@app/dev-dashboard/lib/ai-accounts/aggregator";
import type { SnapshotFilter } from "@app/dev-dashboard/lib/ai-accounts/snapshots";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { z } from "zod";

const commaList = z
    .string()
    .optional()
    .transform((raw) =>
        (raw ?? "")
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
    );

const isoInstant = z.string().refine((raw) => !Number.isNaN(Date.parse(raw)), {
    message: "expected an ISO-8601 instant",
});

const filterSchema = z.object({ providers: commaList, accounts: commaList });

const usageSeriesSchema = z.object({
    providers: commaList,
    accounts: commaList,
    keys: commaList,
    from: isoInstant,
    to: isoInstant,
    step: z.coerce.number().int().positive().optional(),
});

const spendTotalsSchema = z.object({
    from: isoInstant,
    to: isoInstant,
    accounts: commaList,
    source: z.enum(["calls", "transcripts", "both"]).default("transcripts"),
});

const spendSeriesSchema = spendTotalsSchema.extend({
    grain: z.enum(["minute", "hour", "day", "week"]).default("hour"),
});

/** `URLSearchParams` gives `null` for a missing key; zod wants `undefined`. */
function pick(query: URLSearchParams, ...keys: string[]): Record<string, string | undefined> {
    return Object.fromEntries(keys.map((key) => [key, query.get(key) ?? undefined]));
}

function zodMessage(error: z.ZodError): string {
    return error.issues.map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`).join("; ");
}

/**
 * A window that ends in the future would ask the transcript scan and the call log
 * for buckets that cannot exist yet, and the chart would draw an empty tail as if
 * it were zero spend. Clamp rather than reject: a client clock runs a little fast.
 */
function clampTo(to: string, now = Date.now()): string {
    const parsed = Date.parse(to);
    return parsed > now ? new Date(now).toISOString() : to;
}

/**
 * The eight handlers, once. `aiRoutes` mounts them at `/api/ai/*` and
 * `claudeRoutes` mounts three of them at the old `/api/claude/*` paths with the
 * query pinned to anthropic, so the two doors can never answer differently.
 */
export function aiHandlers(agg: AiAggregator) {
    return {
        async accounts(): Promise<RouteResult> {
            try {
                return { kind: "json", status: 200, body: await agg.listAccounts() };
            } catch (err) {
                return errorResult(err);
            }
        },

        async usage(filter: SnapshotFilter): Promise<RouteResult> {
            try {
                return { kind: "json", status: 200, body: await agg.getCurrentSnapshots(filter) };
            } catch (err) {
                return errorResult(err);
            }
        },

        async usageRefresh(filter: SnapshotFilter): Promise<RouteResult> {
            try {
                return { kind: "json", status: 200, body: await agg.refreshSnapshots(filter) };
            } catch (err) {
                return errorResult(err);
            }
        },

        async usageSeries(query: UsageSeriesQuery): Promise<RouteResult> {
            try {
                return { kind: "json", status: 200, body: await agg.getUsageSeries(query) };
            } catch (err) {
                return errorResult(err);
            }
        },

        async spendTotals(query: SpendTotalsQuery): Promise<RouteResult> {
            try {
                return { kind: "json", status: 200, body: await agg.getSpendTotals(query) };
            } catch (err) {
                return errorResult(err);
            }
        },

        async spendSeries(query: SpendSeriesQuery): Promise<RouteResult> {
            try {
                return { kind: "json", status: 200, body: await agg.getSpendSeries(query) };
            } catch (err) {
                return errorResult(err);
            }
        },

        async daemon(): Promise<RouteResult> {
            try {
                return { kind: "json", status: 200, body: await agg.getAiDaemonStatus() };
            } catch (err) {
                return errorResult(err);
            }
        },

        async daemonRegister(): Promise<RouteResult> {
            try {
                return { kind: "json", status: 200, body: await agg.registerAiDaemon() };
            } catch (err) {
                return errorResult(err);
            }
        },
    };
}

export function aiRoutes(agg: AiAggregator = defaultAiAggregator()): RouteDef[] {
    const h = aiHandlers(agg);

    return [
        { method: "GET", pattern: AI_ACCOUNTS_API.accounts, handler: () => h.accounts() },
        {
            method: "GET",
            pattern: AI_ACCOUNTS_API.usage,
            handler: (ctx) => {
                const parsed = filterSchema.safeParse(pick(ctx.query, "providers", "accounts"));

                if (!parsed.success) {
                    return errorResult(new Error(zodMessage(parsed.error)), 400);
                }

                return h.usage(parsed.data);
            },
        },
        {
            method: "POST",
            pattern: AI_ACCOUNTS_API.usageRefresh,
            handler: (ctx) => {
                const parsed = filterSchema.safeParse(pick(ctx.query, "providers", "accounts"));

                if (!parsed.success) {
                    return errorResult(new Error(zodMessage(parsed.error)), 400);
                }

                return h.usageRefresh(parsed.data);
            },
        },
        {
            method: "GET",
            pattern: AI_ACCOUNTS_API.usageSeries,
            handler: (ctx) => {
                const parsed = usageSeriesSchema.safeParse(
                    pick(ctx.query, "providers", "accounts", "keys", "from", "to", "step")
                );

                if (!parsed.success) {
                    return errorResult(new Error(zodMessage(parsed.error)), 400);
                }

                return h.usageSeries({ ...parsed.data, to: clampTo(parsed.data.to) });
            },
        },
        {
            method: "GET",
            pattern: AI_ACCOUNTS_API.spendTotals,
            handler: (ctx) => {
                const parsed = spendTotalsSchema.safeParse(pick(ctx.query, "from", "to", "accounts", "source"));

                if (!parsed.success) {
                    return errorResult(new Error(zodMessage(parsed.error)), 400);
                }

                return h.spendTotals({ ...parsed.data, to: clampTo(parsed.data.to) });
            },
        },
        {
            method: "GET",
            pattern: AI_ACCOUNTS_API.spendSeries,
            handler: (ctx) => {
                const parsed = spendSeriesSchema.safeParse(
                    pick(ctx.query, "from", "to", "accounts", "source", "grain")
                );

                if (!parsed.success) {
                    return errorResult(new Error(zodMessage(parsed.error)), 400);
                }

                return h.spendSeries({ ...parsed.data, to: clampTo(parsed.data.to) });
            },
        },
        { method: "GET", pattern: AI_ACCOUNTS_API.daemon, handler: () => h.daemon() },
        { method: "POST", pattern: AI_ACCOUNTS_API.daemonRegister, handler: () => h.daemonRegister() },
    ];
}
