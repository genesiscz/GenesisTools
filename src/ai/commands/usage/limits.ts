import { formatLimitLine } from "@app/ai/lib/accounts/last-usage";
import { usageProviderValues } from "@app/ai/lib/usage/provider-values";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { LimitKind } from "@genesiscz/utils/ai/providers/account-features";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import {
    type AccountKey,
    accountKeysOf,
    addReservedHarnessOption,
    addWindowOptions,
    parseStep,
    refuseHarness,
    resolveProviderList,
    resolveStepMs,
    resolveWindow,
    selectAccounts,
    splitList,
    type UsageEnvelope,
    UsageQueryError,
    type UsageWarning,
    usageEnvelope,
    type WindowFlags,
} from "@genesiscz/utils/ai/usage/contract";
import { readSnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import {
    LIMITS_NOW_SCHEMA,
    type LimitsNowData,
    limitsNow,
    snapshotsFromCache,
    usageAccountKeys,
    type WireAccountUsageSnapshot,
} from "@genesiscz/utils/ai/usage-poll/limits-now";
import { pollAccounts, usagePlugins } from "@genesiscz/utils/ai/usage-poll/poll";
import {
    isLimitKind,
    LIMIT_KIND_VALUES,
    LIMITS_SERIES_SCHEMA,
    type LimitSeriesData,
    type LimitSeriesItem,
    readLimitSeries,
} from "@genesiscz/utils/ai/usage-poll/series";
import type { SeriesAgg } from "@genesiscz/utils/ai/usage-poll/series-rows";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

const TOOL = "tools ai usage";
const AGG_VALUES: readonly SeriesAgg[] = ["last", "minmax", "raw"];

interface LimitsOptions {
    provider?: string[] | boolean;
    account?: string[];
    json?: boolean;
    fresh?: boolean;
    cached?: boolean;
    harness?: string[] | boolean;
}

interface SeriesOptions extends LimitsOptions, WindowFlags {
    step?: string;
    agg?: string | boolean;
    kind?: string[] | boolean;
}

/**
 * A refusal the user can fix: an enumerated flag gets its value list, anything else its
 * message. Never thrown further, so commander prints no stack.
 */
function refuse(err: UsageQueryError, subcommand: string[]): void {
    if (err.code === "unknown-provider") {
        out.printlnErr(
            suggestEnumFlag(TOOL, "--provider", usageProviderValues(), {
                subcommand,
                ...(err.details.given === undefined ? {} : { given: err.details.given }),
            })
        );
    } else {
        out.printlnErr(err.message);
    }

    process.exitCode = 1;
}

async function guarded(subcommand: string[], run: () => Promise<void>): Promise<void> {
    try {
        await run();
    } catch (err) {
        if (err instanceof UsageQueryError) {
            logger.debug({ code: err.code, details: err.details }, "[ai-usage] refused the command line");
            refuse(err, subcommand);
            return;
        }

        throw err;
    }
}

function accountLabel(account: AccountKey): string {
    return `${providerAliasOf(account.provider)}/${account.accountName}`;
}

function printWarnings(warnings: readonly UsageWarning[]): void {
    for (const warning of warnings) {
        out.printlnErr(pc.yellow(`warning: ${warning.message}`));
    }
}

function statusOf(snapshot: WireAccountUsageSnapshot): string {
    if (snapshot.needsLogin) {
        return pc.red(`needs login: ${snapshot.needsLogin.remedy}`);
    }

    if (snapshot.blocked) {
        return pc.yellow(`blocked until ${snapshot.blocked.until}`);
    }

    if (snapshot.error) {
        return pc.red(snapshot.error);
    }

    if (snapshot.stale) {
        return pc.yellow(`stale: ${snapshot.stale.reason}`);
    }

    return pc.green("ok");
}

function renderLimits(envelope: UsageEnvelope<LimitsNowData>): void {
    renderCliHeader("Usage limits", `${envelope.data.accounts.length} accounts · every window now`);
    const table = createBoxTable(["ACCOUNT", "WINDOWS", "STATUS"]);

    for (const snapshot of envelope.data.accounts) {
        const windows = snapshot.limits.map((window) => `${window.label} ${formatLimitLine(window)}`).join("\n");
        table.push([accountLabel(snapshot), windows || pc.dim("no windows reported"), statusOf(snapshot)]);
    }

    out.println(table.toString());
    printWarnings(envelope.warnings);
}

function peakOf(item: LimitSeriesItem): number | undefined {
    const values = "bins" in item ? item.bins.map((bin) => bin.max) : item.points.map((point) => point.v);
    return values.length > 0 ? Math.max(...values) : undefined;
}

function lastOf(item: LimitSeriesItem): number | undefined {
    return "bins" in item ? item.bins.at(-1)?.close : item.points.at(-1)?.v;
}

function percentCell(value: number | undefined): string {
    return value === undefined ? pc.dim("—") : `${value.toFixed(1)}%`;
}

function renderSeries(envelope: UsageEnvelope<LimitSeriesData>): void {
    const window = envelope.window;
    renderCliHeader("Limit series", window ? `${window.label} · ${window.tz} · step ${envelope.data.stepMs} ms` : "");
    const table = createBoxTable([
        "ACCOUNT",
        "WINDOW",
        "KIND",
        envelope.data.agg === "minmax" ? "BINS" : "POINTS",
        "LAST",
        "PEAK",
        "RESETS",
    ]);

    for (const item of envelope.data.series) {
        const count = "bins" in item ? item.bins.length : item.points.length;
        table.push([
            accountLabel(item),
            truncateDisplay(item.label, 18),
            item.kind ?? pc.dim("—"),
            String(count),
            percentCell(lastOf(item)),
            percentCell(peakOf(item)),
            String(item.resets.length),
        ]);
    }

    out.println(table.toString());
    printWarnings(envelope.warnings);
}

async function emit<T>(envelope: UsageEnvelope<T>, json: boolean | undefined, render: (e: UsageEnvelope<T>) => void) {
    if (json) {
        out.result(envelope);
        await out.flush();
        return;
    }

    render(envelope);
}

async function runLimits(opts: LimitsOptions): Promise<void> {
    refuseHarness(opts.harness);

    if (opts.cached && opts.fresh) {
        throw new UsageQueryError("bad-value", "--cached never polls and --fresh always does; pass one of them.");
    }

    const providers = resolveProviderList(opts.provider);
    const providerIds = providers ?? usagePlugins().map((entry) => entry.plugin.id);
    const store = await AiConfigStore.readOnly();
    const candidates = usageAccountKeys(store.accounts(), providerIds, { visibleOnly: true });
    const selection = selectAccounts(opts.account, candidates);
    const pollProviders = selection ? [...new Set(selection.map((account) => account.provider))] : providers;
    const cache = opts.cached ? await readSnapshotsCache() : null;
    const snapshots = opts.cached
        ? snapshotsFromCache(cache)
        : await pollAccounts({
              ...(pollProviders === undefined ? {} : { providers: pollProviders }),
              ...(selection === undefined ? {} : { accountFilter: selection.map((account) => account.accountName) }),
              ...(opts.fresh ? { force: true } : {}),
          });
    const { data, warnings } = limitsNow(snapshots, {
        ...(providers === undefined ? {} : { providers }),
        ...(selection === undefined ? {} : { accounts: selection }),
    });

    if (opts.cached && cache === null) {
        warnings.push({
            code: "no-cache",
            message: `No poll has written the snapshots file yet. Run ${TOOL} limits without --cached.`,
        });
    }

    logger.debug(
        {
            providers: providerIds,
            selected: selection?.length,
            accounts: data.accounts.length,
            cached: opts.cached === true,
        },
        "[ai-usage] limits now"
    );

    const envelope = usageEnvelope({
        ...LIMITS_NOW_SCHEMA,
        now: new Date(),
        accounts: selection ?? accountKeysOf(data.accounts),
        data,
        warnings,
    });
    await emit(envelope, opts.json, renderLimits);
}

function resolveAgg(raw: string | boolean | undefined): SeriesAgg {
    if (raw === undefined || raw === false) {
        return "last";
    }

    const given = raw === true ? undefined : raw.trim().toLowerCase();
    const agg = AGG_VALUES.find((value) => value === given);

    if (agg === undefined) {
        throw new UsageQueryError(
            "bad-value",
            suggestEnumFlag(TOOL, "--agg", AGG_VALUES, {
                subcommand: ["limits", "series"],
                ...(raw === true ? {} : { given: raw }),
            })
        );
    }

    return agg;
}

function resolveKinds(raw: string[] | boolean | undefined): LimitKind[] | undefined {
    if (raw === undefined || raw === false) {
        return undefined;
    }

    const list = splitList(raw);
    const bad = raw === true || list.length === 0 ? "" : list.find((value) => !isLimitKind(value));

    if (bad !== undefined) {
        throw new UsageQueryError(
            "bad-value",
            suggestEnumFlag(TOOL, "--kind", LIMIT_KIND_VALUES, {
                subcommand: ["limits", "series"],
                ...(bad ? { given: bad } : {}),
            })
        );
    }

    return list.filter(isLimitKind);
}

async function runSeries(opts: SeriesOptions): Promise<void> {
    refuseHarness(opts.harness);

    const now = new Date();
    const window = resolveWindow(opts, { now, defaultSince: "24h" });
    const stepMs = resolveStepMs(parseStep(opts.step), window);
    const agg = resolveAgg(opts.agg);
    const kinds = resolveKinds(opts.kind);
    const providers = resolveProviderList(opts.provider);
    const providerIds = providers ?? usagePlugins().map((entry) => entry.plugin.id);
    const store = await AiConfigStore.readOnly();
    const db = new UsageLimitsDb();
    const directory = usageAccountKeys(store.accounts(), providerIds, { visibleOnly: false });
    const known = new Set(directory.map((account) => `${account.provider}\u0000${account.accountName}`));
    // History outlives config: an account removed from config still has rows under its name,
    // and `--account <old name>` must find them.
    const orphans: AccountKey[] = db
        .getAllAccountBuckets()
        .filter((row) => providerIds.includes(row.provider) && !known.has(`${row.provider}\u0000${row.accountName}`))
        .map((row) => ({ provider: row.provider, accountId: row.accountName, accountName: row.accountName }));
    const selection = selectAccounts(opts.account, [...directory, ...accountKeysOf(orphans)]);
    const cache = await readSnapshotsCache();
    const data = readLimitSeries(
        {
            from: window.from.toISOString(),
            to: window.to.toISOString(),
            stepMs,
            agg,
            ...(selection === undefined ? {} : { accounts: selection }),
            ...(providers === undefined ? {} : { providers }),
            ...(kinds === undefined ? {} : { kinds }),
        },
        { db, directory, current: snapshotsFromCache(cache) }
    );
    const warnings: UsageWarning[] = [];

    if (cache === null) {
        warnings.push({
            code: "no-current",
            message: `No poll has written the snapshots file yet, so every "current" is null. Run ${TOOL} limits once.`,
        });
    }

    logger.debug(
        { window: window.label, tz: window.tz, stepMs, agg, series: data.series.length, selected: selection?.length },
        "[ai-usage] limits series"
    );

    const envelope = usageEnvelope({
        ...LIMITS_SERIES_SCHEMA,
        now,
        window,
        accounts: selection ?? accountKeysOf(data.series),
        data,
        warnings,
    });
    await emit(envelope, opts.json, renderSeries);
}

function addSelectorOptions(command: Command): Command {
    return command
        .option("--provider [list...]", `Limit to these providers: ${usageProviderValues().join(" | ")}`)
        .option(
            "--account <list...>",
            "Accounts: id, name, provider/name or a unique part of a name (repeat or comma-separate)"
        )
        .option("--json", "Print the JSON envelope");
}

/**
 * `tools ai usage limits` and `tools ai usage limits series` (design 2026-11-01, step U1). Thin
 * doors: the flags go through `@genesiscz/utils/ai/usage/contract`, the answers come from the
 * usage-poll core, and `--json` prints one `usage.<verb>@1` envelope.
 *
 * `tools ai usage` declares `--provider`, `--account`, `--json`, `--fresh` and `--range` itself,
 * and commander hands those to the PARENT even when typed after `limits`, so every action reads
 * `optsWithGlobals()`.
 */
export function registerAiUsageLimitsCommand(usage: Command): void {
    const limits = addReservedHarnessOption(
        addSelectorOptions(
            usage.command("limits").description("Every account's limit windows now; --json prints usage.limits@1")
        )
            .option("--fresh", "Force a live poll, bypassing the shared per-provider cache")
            .option("--cached", "Read the last poll's snapshots file and never poll")
    ).action(async (_opts: LimitsOptions, command: Command) => {
        await guarded(["limits"], () => runLimits(command.optsWithGlobals<LimitsOptions>()));
    });

    const series = addWindowOptions(
        addSelectorOptions(
            limits
                .command("series")
                .description("Limit windows over time per account; --json prints usage.limits.series@1")
        ),
        { since: "24h" }
    )
        .option(
            "--step <step>",
            "Bin width: auto (720 bins at most) | raw | a duration such as 30s, 5m, 1h (default auto)"
        )
        .option("--agg [mode]", `How a bin is drawn: ${AGG_VALUES.join(" | ")} (default last; minmax keeps every peak)`)
        .option("--kind [kinds...]", `Only these window kinds: ${LIMIT_KIND_VALUES.join(" | ")}`);

    addReservedHarnessOption(series).action(async (_opts: SeriesOptions, command: Command) => {
        await guarded(["limits", "series"], () => runSeries(command.optsWithGlobals<SeriesOptions>()));
    });
}
