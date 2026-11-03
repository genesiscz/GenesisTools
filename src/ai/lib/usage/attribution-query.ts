import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { isLimitKind, LIMIT_KIND_VALUES, type LimitKind } from "@genesiscz/utils/ai/providers/account-features";
import {
    type AttributedEvent,
    type AttributionData,
    attributeBar,
    findSpikes,
    LIMITS_ATTRIBUTION_SCHEMA,
    LIMITS_SPIKES_SCHEMA,
    loadAttributedSpend,
    SPIKE_DEFAULTS,
    type SpikeSettings,
    type SpikesData,
} from "@genesiscz/utils/ai/usage/attribution";
import {
    type AccountKey,
    accountKeysOf,
    refuseHarness,
    resolveProviderList,
    resolveWindow,
    selectAccounts,
    splitList,
    type UsageEnvelope,
    UsageQueryError,
    type UsageWarning,
    usageEnvelope,
    type WindowFlags,
} from "@genesiscz/utils/ai/usage/contract";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { usageAccountKeys } from "@genesiscz/utils/ai/usage-poll/limits-now";
import { usagePlugins } from "@genesiscz/utils/ai/usage-poll/poll";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/series-rows";
import { aiSessionsCommand } from "@genesiscz/utils/genesis-tools/tools/ai";
import { logger } from "@genesiscz/utils/logger";

export interface AttributionOptions extends WindowFlags {
    provider?: string[] | boolean;
    account?: string[];
    kind?: string[] | boolean;
    json?: boolean;
    harness?: string[] | boolean;
}

export interface SpikesOptions extends AttributionOptions {
    minDelta?: string;
    windowMin?: string;
}

/** The attribution doors read a week of history by default: a weekly window's last reset falls inside it. */
const ATTRIBUTION_LOOKBACK = "8d";

export function positive(flag: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined) {
        return fallback;
    }

    const value = Number(raw);

    if (!Number.isFinite(value) || value <= 0) {
        throw new UsageQueryError("bad-value", `${flag} "${raw}" is not a positive number.`, { given: raw });
    }

    return value;
}

export function resolveKinds(
    raw: string[] | boolean | undefined,
    fallback: LimitKind[] | undefined
): LimitKind[] | undefined {
    const enumFlag = { flag: "--kind", values: LIMIT_KIND_VALUES };

    if (raw === true) {
        throw new UsageQueryError("bad-value", `--kind needs a value: ${LIMIT_KIND_VALUES.join(" | ")}.`, { enumFlag });
    }

    const list = splitList(raw);
    const unknown = list.find((value) => !isLimitKind(value));

    if (unknown !== undefined) {
        throw new UsageQueryError("bad-value", `--kind "${unknown}" is not one of ${LIMIT_KIND_VALUES.join(" | ")}.`, {
            given: unknown,
            enumFlag,
        });
    }

    return list.length > 0 ? list.filter(isLimitKind) : fallback;
}

export interface SeriesScope {
    directory: AccountKey[];
    selection: AccountKey[] | undefined;
    series: SeriesEntry[];
    keyOf: (entry: SeriesEntry) => AccountKey;
}

/** The raw readings of the selected accounts and kinds, the account directory (history orphans included). */
export async function readScope(input: {
    opts: AttributionOptions;
    from: Date;
    to: Date;
    kinds: LimitKind[] | undefined;
}): Promise<SeriesScope> {
    const providers = resolveProviderList(input.opts.provider);
    const providerIds = providers ?? usagePlugins().map((entry) => entry.plugin.id);
    const store = await AiConfigStore.readOnly();
    const db = new UsageLimitsDb();

    try {
        const directory = usageAccountKeys(store.accounts(), providerIds, { visibleOnly: false });
        const known = new Set(directory.map((key) => `${key.provider}\u0000${key.accountName}`));
        const orphans = db
            .getAllAccountBuckets()
            .filter(
                (row) => providerIds.includes(row.provider) && !known.has(`${row.provider}\u0000${row.accountName}`)
            )
            .map((row) => ({ provider: row.provider, accountId: row.accountName, accountName: row.accountName }));
        const all = [...directory, ...accountKeysOf(orphans)];
        const selection = selectAccounts(input.opts.account, all);
        const wanted =
            selection === undefined
                ? undefined
                : new Set(selection.map((key) => `${key.provider}\u0000${key.accountName}`));
        const series = providerIds
            .flatMap((provider) =>
                db.getSeries({
                    provider,
                    from: input.from.toISOString(),
                    to: input.to.toISOString(),
                    agg: "raw",
                    step: 0,
                    ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
                })
            )
            .filter((entry) => !wanted || wanted.has(`${entry.provider}\u0000${entry.account}`));
        const keyOf = (entry: SeriesEntry): AccountKey =>
            all.find((key) => key.provider === entry.provider && key.accountName === entry.account) ?? {
                provider: entry.provider,
                accountId: entry.account,
                accountName: entry.account,
            };

        return { directory: all, selection, series, keyOf };
    } finally {
        db.close();
    }
}

export function reportCommand(sessionId: string): string {
    return aiSessionsCommand("report", sessionId);
}

export function spendWarnings(events: readonly AttributedEvent[]): UsageWarning[] {
    const warnings: UsageWarning[] = [
        {
            code: "attribution-by-last-pin",
            message:
                "Claude sessions are matched to accounts by their last pin; a session that changed account counts for the last one.",
        },
    ];
    const unpriced = events.filter((event) => event.unpriced).length;

    if (unpriced > 0) {
        warnings.push({
            code: "unpriced",
            message: `${unpriced} spend events have no known rate; their cost is missing, not 0.`,
        });
    }

    return warnings;
}

/**
 * `tools ai usage limits spikes` (design 2026-11-01, step U9, proposal 4): every rise of a window by at least
 * `--min-delta` points within `--window-min` minutes, with the sessions that spent on that account in the span.
 */
export async function querySpikes(
    opts: SpikesOptions,
    deps: { now?: Date; loadEvents?: typeof loadAttributedSpend } = {}
): Promise<UsageEnvelope<SpikesData>> {
    refuseHarness(opts.harness);

    const now = deps.now ?? new Date();
    const window = resolveWindow(opts, { now, defaultSince: "24h" });
    const settings: SpikeSettings = {
        minDelta: positive("--min-delta", opts.minDelta, SPIKE_DEFAULTS.minDelta),
        windowMinutes: positive("--window-min", opts.windowMin, SPIKE_DEFAULTS.windowMinutes),
        padMinutes: SPIKE_DEFAULTS.padMinutes,
    };
    const kinds = resolveKinds(opts.kind, undefined);
    const scope = await readScope({ opts, from: window.from, to: window.to, kinds });
    const events = await (deps.loadEvents ?? loadAttributedSpend)({
        from: new Date(window.from.getTime() - settings.padMinutes * 60_000),
        now,
        directory: scope.directory,
    });
    const spikes = findSpikes({ series: scope.series, events, accountOf: scope.keyOf, settings, reportCommand });

    logger.debug(
        { window: window.label, series: scope.series.length, spikes: spikes.length },
        "[ai-usage] limits spikes"
    );

    return usageEnvelope({
        ...LIMITS_SPIKES_SCHEMA,
        now,
        window,
        accounts: scope.selection ?? accountKeysOf(spikes.map((spike) => spike.account)),
        data: { settings, spikes },
        warnings: spendWarnings(events),
    });
}

/**
 * `tools ai usage limits attribution` (step U9, proposal 14): for each account's window, the rise since its last
 * reset (or since `--since`) split by project and session, in dollars and in points of the bar.
 */
export async function queryAttribution(
    opts: AttributionOptions,
    deps: { now?: Date; loadEvents?: typeof loadAttributedSpend } = {}
): Promise<UsageEnvelope<AttributionData>> {
    refuseHarness(opts.harness);

    const now = deps.now ?? new Date();
    const asked =
        opts.since !== undefined || opts.from !== undefined || opts.range !== undefined || opts.hours !== undefined;
    const window = resolveWindow(opts, { now, defaultSince: ATTRIBUTION_LOOKBACK });
    const kinds = resolveKinds(opts.kind, ["weekly"]);
    const scope = await readScope({ opts, from: window.from, to: window.to, kinds });
    const events = await (deps.loadEvents ?? loadAttributedSpend)({
        from: window.from,
        now,
        directory: scope.directory,
    });
    const bars = scope.series
        .map((entry) =>
            attributeBar({
                entry,
                account: scope.keyOf(entry),
                events,
                from: window.from,
                to: window.to,
                reportCommand,
            })
        )
        // Without an asked start, a window with no reset in the lookback is answered from the lookback start.
        .filter((bar) => asked || bar.sinceReset || bar.totalUsd > 0 || bar.risePercent > 0)
        .sort((a, b) => b.totalUsd - a.totalUsd);

    logger.debug({ window: window.label, bars: bars.length }, "[ai-usage] limits attribution");

    return usageEnvelope({
        ...LIMITS_ATTRIBUTION_SCHEMA,
        now,
        window,
        accounts: scope.selection ?? accountKeysOf(bars.map((bar) => bar.account)),
        data: { bars },
        warnings: spendWarnings(events),
    });
}
