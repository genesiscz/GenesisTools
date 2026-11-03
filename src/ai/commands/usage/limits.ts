import { formatLimitLine } from "@app/ai/lib/accounts/last-usage";
import {
    type AdviseOptions,
    AGG_VALUES,
    type HealthOptions,
    type LimitsOptions,
    queryAdvice,
    queryHealth,
    queryLimitsNow,
    querySeries,
    type SeriesOptions,
} from "@app/ai/lib/usage/limits-query";
import { usageProviderValues } from "@app/ai/lib/usage/provider-values";
import { FORECAST_DESCRIPTION, type ForecastCommandOptions, runForecastCommand } from "@app/hub/commands/forecast";
import { absentLimitText, LIMIT_KIND_VALUES } from "@genesiscz/utils/ai/providers/account-features";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import type { AdviceRow, AdviseData } from "@genesiscz/utils/ai/usage/advise";
import {
    type AccountKey,
    addReservedHarnessOption,
    addWindowOptions,
    type UsageEnvelope,
    UsageQueryError,
    type UsageWarning,
} from "@genesiscz/utils/ai/usage/contract";
import type { AccountHealth, LimitsHealthData } from "@genesiscz/utils/ai/usage/poll-runs/health";
import type { LimitsNowData, WireAccountUsageSnapshot } from "@genesiscz/utils/ai/usage-poll/limits-now";
import type { LimitSeriesData, LimitSeriesItem } from "@genesiscz/utils/ai/usage-poll/series";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

/**
 * A refusal the user can fix: an enumerated flag gets its value list, anything else its
 * message. Never thrown further, so commander prints no stack.
 */
/**
 * The tool part of the suggested command line. The subcommand words come from argv, which already starts with
 * `usage`, so the tool is `tools ai`: with `tools ai usage` the line read `tools ai usage usage limits ...`.
 */
const SUGGEST_TOOL = "tools ai";

function refuse(err: UsageQueryError, subcommand: string[]): void {
    const given = err.details.given === undefined ? {} : { given: err.details.given };

    if (err.code === "unknown-provider") {
        out.printlnErr(suggestEnumFlag(SUGGEST_TOOL, "--provider", usageProviderValues(), { subcommand, ...given }));
    } else if (err.details.enumFlag) {
        out.printlnErr(
            suggestEnumFlag(SUGGEST_TOOL, err.details.enumFlag.flag, err.details.enumFlag.values, {
                subcommand,
                ...given,
            })
        );
    } else {
        out.printlnErr(err.message);
    }

    process.exitCode = 1;
}

export async function guarded(subcommand: string[], run: () => Promise<void>): Promise<void> {
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

export function accountLabel(account: AccountKey): string {
    return `${providerAliasOf(account.provider)}/${account.accountName}`;
}

export function printWarnings(warnings: readonly UsageWarning[]): void {
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

export function renderLimits(envelope: UsageEnvelope<LimitsNowData>): void {
    renderCliHeader("Usage limits", `${envelope.data.accounts.length} accounts · every window now`);
    const table = createBoxTable(["ACCOUNT", "WINDOWS", "STATUS"]);

    for (const snapshot of envelope.data.accounts) {
        // A window the provider says does not exist is named, as `tools ai usage --no-tui` names it.
        const windows = [
            ...snapshot.limits.map((window) => `${window.label} ${formatLimitLine(window)}`),
            ...(snapshot.absentLimits ?? []).map(absentLimitText),
        ].join("\n");
        table.push([accountLabel(snapshot), windows || pc.dim("no windows reported"), statusOf(snapshot)]);
    }

    out.println(table.toString());

    // `--scored`: the order each provider's ranker picks, best first, with the reason it gives.
    if (envelope.data.ranked) {
        out.println(pc.bold("Ranked (--scored)"));
        const ranked = createBoxTable(["#", "ACCOUNT", "TIER", "SCORE", "WHY"]);

        for (const [index, row] of envelope.data.ranked.entries()) {
            ranked.push([String(index + 1), accountLabel(row), row.tier, String(row.score), row.why]);
        }

        out.println(ranked.toString());
    }

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

/** "3.1%/h now · 1.8%/h safe": the burn beside the budget that lasts to the reset. */
function paceCell(item: LimitSeriesItem): string {
    const forecast = item.forecast;

    if (!forecast) {
        return pc.dim("—");
    }

    const now = forecast.ratePctPerHour === null ? pc.dim("no burn") : `${forecast.ratePctPerHour}%/h now`;
    const safe = forecast.safePctPerHour === null ? "" : ` · ${forecast.safePctPerHour}%/h safe`;
    const tone = forecast.beforeReset ? pc.red : (text: string) => text;

    return tone(`${now}${safe}`);
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
        "PACE",
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
            paceCell(item),
        ]);
    }

    out.println(table.toString());
    printWarnings(envelope.warnings);
}

function lastsText(row: AdviceRow): string {
    // No history or no fresh burn: the readings cannot say how long it lasts, so nothing is promised.
    if (row.forecast === "unknown") {
        return pc.dim("unknown: no recent burn");
    }

    if (row.lastsMinutes === null) {
        return "lasts to its resets";
    }

    const hours = Math.floor(row.lastsMinutes / 60);
    const minutes = row.lastsMinutes % 60;
    return `lasts ${hours > 0 ? `${hours}h${String(minutes).padStart(2, "0")}m` : `${minutes}m`} (${row.bindingLabel} binds)`;
}

function renderAdvice(envelope: UsageEnvelope<AdviseData>): void {
    renderCliHeader("Account advice", "next account per workload · unused at reset");

    for (const provider of envelope.data.providers) {
        const table = createBoxTable(["WORKLOAD", "NEXT", "LASTS", "WHY", "RUNNER-UP"]);

        for (const profile of provider.profiles) {
            table.push([
                profile.profile,
                profile.pick ? accountLabel(profile.pick) : pc.dim("no usable account"),
                profile.pick ? lastsText(profile.pick) : "",
                truncateDisplay(profile.pick?.why ?? "", 60),
                profile.runnerUp ? accountLabel(profile.runnerUp) : pc.dim("—"),
            ]);
        }

        out.println(table.toString());

        for (const unused of provider.unusedAtReset) {
            out.println(
                `  ${pc.yellow("unused at reset")}: ${accountLabel(unused)} ${unused.label} ${unused.unusedPct}% on ${new Date(unused.resetsAt).toLocaleString()}`
            );
        }
    }

    printWarnings(envelope.warnings);
}

const OUTCOME_TONE: Record<AccountHealth["outcome"], (text: string) => string> = {
    ok: pc.green,
    stale: pc.yellow,
    error: pc.red,
    blocked: pc.red,
    backoff: pc.magenta,
    "needs-login": pc.red,
    unmeasured: pc.dim,
};

function shortTime(iso: string | null): string {
    return iso === null ? pc.dim("—") : new Date(iso).toLocaleString();
}

function gapsCell(account: AccountHealth): string {
    if (account.gaps.length === 0) {
        return pc.dim("none");
    }

    const longest = account.gaps.reduce((best, gap) => (gap.minutes > best.minutes ? gap : best));
    return `${account.gaps.length} (longest ${longest.minutes} min from ${new Date(longest.from).toLocaleTimeString()})`;
}

function renderHealth(envelope: UsageEnvelope<LimitsHealthData>): void {
    const { daemon } = envelope.data;
    renderCliHeader("Poll coverage", `${envelope.window?.label ?? ""} · daemon ${daemon.alive ? "up" : "down"}`);
    const table = createBoxTable(["ACCOUNT", "NOW", "SINCE", "COVERAGE", "GAPS", "SOURCE"]);

    for (const account of envelope.data.accounts) {
        const reason =
            account.outcome === "ok" || account.reason === null ? "" : `\n${truncateDisplay(account.reason, 40)}`;
        table.push([
            accountLabel(account),
            `${OUTCOME_TONE[account.outcome](account.outcome)}${reason}`,
            shortTime(account.since),
            `${account.coveragePct}%`,
            gapsCell(account),
            account.source ?? pc.dim("—"),
        ]);
    }

    out.println(table.toString());
    out.println(
        daemon.alive
            ? pc.dim(
                  `Daemon heartbeat ${Math.round((daemon.heartbeatAgeMs ?? 0) / 1000)} s ago; last round ${shortTime(daemon.lastRoundAt)}.`
              )
            : pc.red("The usage daemon is not running, so nothing is measured.")
    );
    printWarnings(envelope.warnings);
}

async function runHealth(opts: HealthOptions): Promise<void> {
    await emit(await queryHealth(opts), opts.json, renderHealth);
}

async function runLimits(opts: LimitsOptions): Promise<void> {
    await emit(await queryLimitsNow(opts), opts.json, renderLimits);
}

async function runSeries(opts: SeriesOptions): Promise<void> {
    await emit(await querySeries(opts), opts.json, renderSeries);
}

async function runAdvice(opts: AdviseOptions): Promise<void> {
    await emit(await queryAdvice(opts), opts.json, renderAdvice);
}

export async function emit<T>(
    envelope: UsageEnvelope<T>,
    json: boolean | undefined,
    render: (e: UsageEnvelope<T>) => void
): Promise<void> {
    if (json) {
        out.result(envelope);
        await out.flush();
        return;
    }

    render(envelope);
}

export function addSelectorOptions(command: Command): Command {
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
export function registerAiUsageLimitsCommand(usage: Command): Command {
    const limits = addReservedHarnessOption(
        addSelectorOptions(
            usage.command("limits").description("Every account's limit windows now; --json prints usage.limits@1")
        )
            .option("--fresh", "Force a live poll, bypassing the shared per-provider cache")
            .option("--cached", "Read the last poll's snapshots file and never poll")
            .option("--scored", "Rank every account with its own provider's ranker (data.ranked)")
    ).action(async (_opts: LimitsOptions, command: Command) => {
        await guarded(["limits"], () => runLimits(command.optsWithGlobals<LimitsOptions>()));
    });

    addReservedHarnessOption(
        addSelectorOptions(
            limits
                .command("advise")
                .description(
                    "The next account per workload (default, fan-out, long-run, --model), how long it lasts, and the capacity left unused at each reset; --json prints usage.limits.advise@1"
                )
        )
            .option("--fresh", "Force a live poll, bypassing the shared per-provider cache")
            .option("--cached", "Read the last poll's snapshots file and never poll")
            .option("--model <names...>", "Add a profile per model that ranks by that model's own weekly window")
    ).action(async (_opts: AdviseOptions, command: Command) => {
        await guarded(["limits", "advise"], () => runAdvice(command.optsWithGlobals<AdviseOptions>()));
    });

    addReservedHarnessOption(
        addWindowOptions(
            addSelectorOptions(
                limits
                    .command("health")
                    .description(
                        "Poll coverage per account: idle, unmeasured, stale, held back or blocked, with the gaps; --json prints usage.limits.health@1"
                    )
            ),
            { since: "24h" }
        )
    ).action(async (_opts: HealthOptions, command: Command) => {
        await guarded(["limits", "health"], () => runHealth(command.optsWithGlobals<HealthOptions>()));
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

    // An alias of `tools hub forecast` (owner decision 2026-11-01 22:30): the same flags and the
    // same runner, so the bytes match. `tools hub forecast` stays the real command.
    limits
        .command("forecast")
        .description(`${FORECAST_DESCRIPTION}. Alias of ${toolCommand("hub", "forecast")}`)
        .option("--provider <id>", "only this usage provider (anthropic-sub, openai-sub, grok-sub)")
        .option("--account <name>", "only this account")
        .option("--json", "machine-readable output (the hub reads this)")
        .action(async (_opts: ForecastCommandOptions, command: Command) => {
            await guarded(["limits", "forecast"], () =>
                runForecastCommand(forecastOptions(command.optsWithGlobals<ForecastFlags>()))
            );
        });

    return limits;
}

/** The parent's variadic `--provider`/`--account` take these flags first; the alias accepts one value each, as hub forecast does. */
interface ForecastFlags {
    provider?: string | string[] | boolean;
    account?: string | string[];
    json?: boolean;
}

function single(flag: string, value: string | string[] | boolean | undefined): string | undefined {
    if (value === undefined || value === false) {
        return undefined;
    }

    const list = typeof value === "string" ? [value] : value === true ? [] : value;

    if (list.length !== 1) {
        throw new UsageQueryError(
            "bad-value",
            `${flag} takes one value here, as in ${toolCommand("hub", "forecast")}.`
        );
    }

    return list[0];
}

export function forecastOptions(flags: ForecastFlags): ForecastCommandOptions {
    const provider = single("--provider", flags.provider);
    const account = single("--account", flags.account);

    return {
        ...(provider === undefined ? {} : { provider }),
        ...(account === undefined ? {} : { account }),
        ...(flags.json ? { json: true } : {}),
    };
}
