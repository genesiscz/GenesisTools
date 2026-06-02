import { getCurrentUsage, getUsageHistory, getUsageHistoryMulti } from "@app/dev-dashboard/lib/claude-usage/aggregator";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";

export function claudeRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/claude/usage",
            handler: async () => {
                try {
                    return { kind: "json", status: 200, body: await getCurrentUsage() };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/claude/usage/history",
            handler: (ctx) => {
                const account = ctx.query.get("account") ?? "";
                const bucketsParam = ctx.query.get("buckets");
                const bucket = ctx.query.get("bucket") ?? "five_hour";
                const minutes = Number.parseInt(ctx.query.get("minutes") ?? "1440", 10);
                const safeMinutes = Number.isFinite(minutes) ? minutes : 1440;

                try {
                    if (bucketsParam) {
                        const buckets = bucketsParam
                            .split(",")
                            .map((b) => b.trim())
                            .filter(Boolean);

                        return {
                            kind: "json",
                            status: 200,
                            body: getUsageHistoryMulti({ account, buckets, minutes: safeMinutes }),
                        };
                    }

                    return {
                        kind: "json",
                        status: 200,
                        body: getUsageHistory({ account, bucket, minutes: safeMinutes }),
                    };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
    ];
}
