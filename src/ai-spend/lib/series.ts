import { homedir } from "node:os";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { DiscoveredHome } from "@genesiscz/utils/ai/providers/account-features";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import {
    type AccountRef,
    CLAUDE_ALL_ACCOUNT_ID,
    CLAUDE_ALL_ACCOUNT_NAME,
    type SpendGrain,
    type SpendSeriesBucket,
    type SpendSeriesPoint,
    UNBOUND_ACCOUNT_ID,
} from "@genesiscz/utils/ai/usage";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { loadPricing } from "./config";
import { AGENT_IDS, type AgentId, type MonitorDriver } from "./drivers";
import { type CompactEvent, collectSeriesEvents } from "./events-cache";
import type { readTail } from "./monitor";
import { hourKey, mondayOf, systemTimeZone, zonedDay } from "./reports/dates";

/**
 * Transcript spend over time, bucketed, split by account.
 *
 * The other half of the dashboard's picture is the call log
 * (`queryUsage({ grain })`), which measures what GenesisTools itself spent.
 * These two never sum: a Claude Code turn appears here and never there. The
 * point and account shapes are shared (`src/utils/ai/usage/types.ts`) so a
 * chart can render either without knowing which produced it.
 */

/** Transcripts are hour-resolution at best; `minute` belongs to the call log. */
export type TranscriptGrain = Exclude<SpendGrain, "minute">;

export interface SpendSeriesQuery {
    /** ISO instant or `YYYY-MM-DD`, inclusive. */
    from: string;
    /** ISO instant or `YYYY-MM-DD`, exclusive. */
    to: string;
    grain: SpendGrain;
    /** Default: every native agent. */
    sources?: readonly AgentId[];
    /** Default: every account. `"(unbound)"` and `"claude-all"` are valid entries. */
    accountIds?: readonly string[];
    byModel?: boolean;
    /** Test injection, same as `BuildMonitorOptions.home`. */
    home?: string;
}

/**
 * Wiring the query itself has no business carrying: where the config accounts
 * came from, which drivers to walk, which cache dir to use.
 */
export interface SpendSeriesOptions {
    storage?: Storage;
    /** Enabled accounts, so a bound home's events carry a real account id. */
    accounts?: readonly AccountEntry[];
    /** Homes from `--all-homes`; the caller awaited `discoverHomes()`. */
    discoveredHomes?: Partial<Record<AgentId, readonly DiscoveredHome[]>>;
    drivers?: readonly MonitorDriver[];
    timeZone?: string;
    now?: Date;
    /** Injectable tail reader, so a test can prove an unchanged file is not re-read. */
    readTailFn?: typeof readTail;
}

export interface SpendSeriesResult {
    points: SpendSeriesPoint[];
    accounts: AccountRef[];
    /** Events that carried tokens but no known rate. Their cost is missing, not zero. */
    unpriced: number;
}

/** Thrown for `grain: "minute"`, which transcripts cannot answer. */
export class UnsupportedGrainError extends Error {
    constructor(grain: SpendGrain) {
        super(
            `ai-spend series does not support grain "${grain}": coding-agent transcripts are hour-resolution at best. ` +
                `Use "hour", "day" or "week" here, and queryUsage({ grain: "minute" }) for the call log.`
        );
        this.name = "UnsupportedGrainError";
    }
}

function bucketKey(timestamp: string, grain: TranscriptGrain, timeZone: string): string {
    if (grain === "hour") {
        return hourKey(timestamp, timeZone);
    }

    const day = zonedDay(timestamp, timeZone);

    if (grain === "week") {
        return day === "" ? "" : mondayOf(day);
    }

    return day;
}

/**
 * D6: `~/.claude/projects` carries no account marker, so every Anthropic
 * transcript reports as ONE row. Per-account Claude numbers come from the call
 * log, which is keyed by `AccountEntry.id` at write time.
 */
function seriesAccountId(event: CompactEvent): string {
    if (event.source === "claude") {
        return CLAUDE_ALL_ACCOUNT_ID;
    }

    return event.accountId ?? UNBOUND_ACCOUNT_ID;
}

function addTo(bucket: Record<string, SpendSeriesBucket>, key: string, event: CompactEvent): void {
    const existing = bucket[key] ?? { costUsd: 0, tokens: 0 };
    existing.costUsd += event.costUsd;
    existing.tokens += event.tokens;
    bucket[key] = existing;
}

function accountRefsFor(ids: Iterable<string>, accounts: readonly AccountEntry[]): AccountRef[] {
    const byId = new Map(accounts.map((account) => [account.id, account]));
    const refs: AccountRef[] = [];

    for (const id of ids) {
        if (id === CLAUDE_ALL_ACCOUNT_ID) {
            refs.push({
                accountId: id,
                accountName: CLAUDE_ALL_ACCOUNT_NAME,
                provider: "anthropic-sub",
            });
            continue;
        }

        const account = byId.get(id);

        if (!account) {
            refs.push({ accountId: id, accountName: id, provider: "" });
            continue;
        }

        refs.push({
            accountId: account.id,
            accountName: account.name,
            provider: account.provider,
            label: account.label ?? providerAliasOf(account.provider),
        });
    }

    return refs.sort((a, b) => a.accountName.localeCompare(b.accountName));
}

export async function buildSpendSeries(
    query: SpendSeriesQuery,
    options: SpendSeriesOptions = {}
): Promise<SpendSeriesResult> {
    if (query.grain === "minute") {
        throw new UnsupportedGrainError(query.grain);
    }

    const grain: TranscriptGrain = query.grain;
    const from = Date.parse(query.from);
    const to = Date.parse(query.to);

    if (Number.isNaN(from) || Number.isNaN(to)) {
        throw new Error(`ai-spend series: unparseable window ${query.from} .. ${query.to}`);
    }

    const storage = options.storage ?? new Storage("ai-spend");
    const pricing = await loadPricing(storage);
    const timeZone = options.timeZone ?? systemTimeZone();
    const wantedAccounts = query.accountIds ? new Set(query.accountIds) : undefined;

    const events = collectSeriesEvents({
        storage,
        pricing,
        home: query.home ?? homedir(),
        sources: query.sources ?? AGENT_IDS,
        minMtimeMs: from,
        accounts: options.accounts,
        discoveredHomes: options.discoveredHomes,
        drivers: options.drivers,
        readTailFn: options.readTailFn,
        now: options.now,
    });

    const buckets = new Map<string, SpendSeriesPoint>();
    const seenAccounts = new Set<string>();
    let unpriced = 0;

    for (const event of events) {
        const at = Date.parse(event.t);

        if (Number.isNaN(at) || at < from || at >= to) {
            continue;
        }

        const accountId = seriesAccountId(event);

        if (wantedAccounts && !wantedAccounts.has(accountId)) {
            continue;
        }

        const key = bucketKey(event.t, grain, timeZone);

        if (key === "") {
            continue;
        }

        let point = buckets.get(key);

        if (!point) {
            point = { t: key, costUsd: 0, tokens: 0, byAccount: {} };

            if (query.byModel) {
                point.byModel = {};
            }

            buckets.set(key, point);
        }

        point.costUsd += event.costUsd;
        point.tokens += event.tokens;
        addTo(point.byAccount, accountId, event);
        seenAccounts.add(accountId);

        if (point.byModel) {
            addTo(point.byModel, event.model ?? "unknown", event);
        }

        if (event.unpriced) {
            unpriced += 1;
        }
    }

    const points = [...buckets.values()].sort((a, b) => a.t.localeCompare(b.t));

    logger.debug({ grain, points: points.length, accounts: seenAccounts.size, unpriced }, "ai-spend: series built");

    return { points, accounts: accountRefsFor(seenAccounts, options.accounts ?? []), unpriced };
}
