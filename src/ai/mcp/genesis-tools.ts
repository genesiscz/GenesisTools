import { AGG_VALUES, queryAdvice, queryLimitsNow, querySeries } from "@app/ai/lib/usage/limits-query";
import type { ToolEntry } from "@app/genesis-tools-mcp/lib/server";
import { LIMIT_KIND_VALUES } from "@genesiscz/utils/ai/providers/account-features";
import { UsageQueryError } from "@genesiscz/utils/ai/usage/contract";
import { buildForecast } from "@genesiscz/utils/ai/usage/forecast/forecast";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";

const { log } = logger.scoped("usage-mcp");

const list = z.array(z.string().trim().min(1));

const selectorShape = {
    provider: list.optional().describe("providers: claude, codex, grok or plugin ids; omitted means every provider"),
    account: list
        .optional()
        .describe("accounts: an id, a name, provider/name or a unique part of a name; omitted means every account"),
};

const limitsSchema = z
    .object({
        ...selectorShape,
        scored: z.boolean().optional().describe("rank every account with its own provider's ranker (data.ranked)"),
    })
    .strict();

const seriesSchema = z
    .object({
        ...selectorShape,
        since: z.string().optional().describe("start: 90m, 6h, 7d, 4w, YYYY-MM-DD, an ISO instant, today, week, month"),
        until: z.string().optional().describe("end, in the same forms; omitted means now"),
        tz: z.string().optional().describe("IANA zone for dates and keywords; omitted means the system zone"),
        step: z.string().optional().describe("auto (720 bins at most), raw, or a duration such as 5m"),
        agg: z.enum(AGG_VALUES).optional().describe("how a bin is drawn; minmax keeps every peak"),
        kind: z.array(z.enum(LIMIT_KIND_VALUES)).optional().describe("only these window kinds"),
    })
    .strict();

const forecastSchema = z
    .object({
        provider: z.string().optional().describe("one plugin id: anthropic-sub, openai-sub, grok-sub"),
        account: z.string().optional().describe("one account name"),
    })
    .strict();

const adviseSchema = z
    .object({
        ...selectorShape,
        model: list.optional().describe("add a profile per model that ranks by that model's own weekly window"),
    })
    .strict();

/** A refusal the caller can fix comes back as text with its code; anything else is a real failure and throws. */
async function answer(tool: string, run: () => Promise<unknown>): Promise<string> {
    try {
        return SafeJSON.stringify(await run());
    } catch (err) {
        if (err instanceof UsageQueryError) {
            log.debug({ tool, code: err.code }, "usage MCP refused the arguments");
            return SafeJSON.stringify({ error: err.code, message: err.message });
        }

        throw err;
    }
}

/**
 * The `usage` capability (design 2026-11-01 section 7, step U4): read-only doors over the same core as `tools ai usage
 * limits ...`. Every tool reads the last poll's snapshots file and the history store; none polls a provider, so a call
 * never spends a rate-limited request or a credential.
 */
export function usageToolEntries(): Record<string, ToolEntry> {
    return {
        usage_limits: {
            description: `Every AI account's limit windows now (Claude, Codex, Grok), from the last usage poll: one usage.limits@1 envelope {schema, generatedAt, selector, data:{accounts, ranked?}, warnings}. Same core as \`${toolCommand("ai usage limits --cached --json")}\`.`,
            inputSchema: z.toJSONSchema(limitsSchema, { io: "input" }),
            handler: async (args) => {
                const input = limitsSchema.parse(args);
                return answer("usage_limits", () => queryLimitsNow({ ...input, cached: true }));
            },
        },
        usage_series: {
            description: `Limit windows over time per account: one usage.limits.series@1 envelope whose data.series items carry points or minmax bins, resets, availability spans, the current value and a forecast with the pace band and the safe pace. Same core as \`${toolCommand("ai usage limits series --json")}\`.`,
            inputSchema: z.toJSONSchema(seriesSchema, { io: "input" }),
            handler: async (args) => {
                const input = seriesSchema.parse(args);
                return answer("usage_series", () => querySeries(input));
            },
        },
        usage_forecast: {
            description: `When each account's windows run out at the recent burn rate, from recorded snapshots only. The same JSON as \`${toolCommand("hub forecast --json")}\`.`,
            inputSchema: z.toJSONSchema(forecastSchema, { io: "input" }),
            handler: async (args) => {
                const input = forecastSchema.parse(args);
                return answer("usage_forecast", () => buildForecast(input));
            },
        },
        usage_advise: {
            description: `Which account to use next per workload (default, fan-out, long-run, model:<name>), how long it lasts, and the weekly capacity left unused at each reset: one usage.limits.advise@1 envelope. Same core as \`${toolCommand("ai usage limits advise --cached --json")}\`.`,
            inputSchema: z.toJSONSchema(adviseSchema, { io: "input" }),
            handler: async (args) => {
                const input = adviseSchema.parse(args);
                return answer("usage_advise", () => queryAdvice({ ...input, cached: true }));
            },
        },
    };
}
