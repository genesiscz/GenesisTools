import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { loadAttributedSpend } from "@genesiscz/utils/ai/usage/attribution";
import {
    type AccountKey,
    addWindowOptions,
    resolveProviderList,
    resolveWindow,
    splitList,
    type UsageEnvelope,
    UsageQueryError,
    type UsageWarning,
    usageEnvelope,
    type WindowFlags,
} from "@genesiscz/utils/ai/usage/contract";
import { AGENT_IDS } from "@genesiscz/utils/ai/usage/spend/drivers";
import {
    isPivotDimension,
    PIVOT_DIMENSIONS,
    type PivotDimension,
    pivotSpend,
    type SpendHeatmap,
    type SpendPivot,
} from "@genesiscz/utils/ai/usage/spend/pivot";
import { type PlanValue, planValues } from "@genesiscz/utils/ai/usage/spend/plans";
import type { TranscriptGrain } from "@genesiscz/utils/ai/usage/spend/series";
import {
    isWasteDimension,
    type SpendWaste,
    scanSpendWaste,
    WASTE_DIMENSIONS,
    type WasteDimension,
} from "@genesiscz/utils/ai/usage/spend/waste";
import { loadDashboardConfig, updateDashboardConfig } from "@genesiscz/utils/ai/usage-poll/dashboard-config";
import { readSnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { snapshotsFromCache, usageAccountKeys } from "@genesiscz/utils/ai/usage-poll/limits-now";
import { usagePlugins } from "@genesiscz/utils/ai/usage-poll/poll";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/series-rows";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { aiSessionReportCommand } from "@genesiscz/utils/genesis-tools/tools/ai";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { harnessSources } from "./harness-flag";
import { buildProxyReport, type ProxyReport } from "./proxy";

/**
 * The spend verbs of design 2026-11-01 step U11 (proposals 10, 17, 19), in the `tools ai-spend` tree, so
 * `tools ai usage spend` mounts them too. Each takes the usage window grammar and prints one `usage.spend.<verb>@1`
 * envelope with `--json`.
 */

const TOOL = "tools ai-spend";
const GRAINS: readonly TranscriptGrain[] = ["hour", "day", "week"];

async function emit<T>(envelope: UsageEnvelope<T>, json: boolean | undefined, render: (e: UsageEnvelope<T>) => void) {
    if (json) {
        out.result(envelope);
        await out.flush();
        return;
    }

    render(envelope);

    for (const warning of envelope.warnings) {
        out.printlnErr(pc.yellow(`warning: ${warning.message}`));
    }
}

/** Prints a refusal the user can fix and sets the exit code; never a stack. */
async function guarded(run: () => Promise<void>): Promise<void> {
    try {
        await run();
    } catch (err) {
        if (err instanceof UsageQueryError) {
            out.printlnErr(err.message);
            process.exitCode = 1;
            return;
        }

        throw err;
    }
}

async function accountDirectory(): Promise<AccountKey[]> {
    const store = await AiConfigStore.readOnly();
    return usageAccountKeys(
        store.accounts(),
        usagePlugins().map((entry) => entry.plugin.id),
        { visibleOnly: false }
    );
}

function usd(value: number): string {
    return `$${value.toFixed(2)}`;
}

interface PivotOpts extends WindowFlags {
    by?: string | boolean;
    grain?: string | boolean;
    heatmap?: boolean;
    json?: boolean;
}

function renderPivot(envelope: UsageEnvelope<SpendPivot>): void {
    const pivot = envelope.data;
    renderCliHeader(
        "Spend pivot",
        `${envelope.window?.label ?? ""} · by ${pivot.by.join(", ") || "nothing"} · ${pivot.grain}`
    );
    const table = createBoxTable([...pivot.by.map((dim) => dim.toUpperCase()), "COST", "TOKENS", "BUCKETS"]);

    for (const group of pivot.groups.slice(0, 40)) {
        table.push([
            ...pivot.by.map((dim) => truncateDisplay(group.key[dim] ?? "", 32)),
            usd(group.costUsd),
            group.tokens.toLocaleString(),
            String(group.points.length),
        ]);
    }

    out.println(table.toString());
    out.println(
        `total ${usd(pivot.total.costUsd)}${pivot.total.unpriced > 0 ? pc.yellow(` · ${pivot.total.unpriced} unpriced`) : ""}`
    );

    if (pivot.heatmap) {
        renderHeatmap(pivot.heatmap);
    }
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SHADES = " ░▒▓█";

/** `--heatmap`: one row per weekday, one shade per hour, the darkest at the busiest hour of the week. */
function renderHeatmap(heatmap: SpendHeatmap): void {
    const peak = Math.max(0, ...heatmap.cells.flat());
    out.println("");
    out.println(`average dollars by hour of the week, over ${heatmap.weeks} week(s); busiest hour ${usd(peak)}`);
    out.println("     00    06    12    18");

    for (const [index, row] of heatmap.cells.entries()) {
        const shades = row.map((value) => SHADES[peak > 0 ? Math.ceil((value / peak) * (SHADES.length - 1)) : 0]);
        out.println(`${WEEKDAYS[index] ?? "?"}  ${shades.join("")}`);
    }
}

function registerPivot(program: Command): void {
    addWindowOptions(
        program
            .command("pivot")
            .description(
                "Transcript spend split by provider, account, model, project, harness or session, bucketed by hour, day or week"
            )
            .option("--by [dims]", `Comma list of: ${PIVOT_DIMENSIONS.join(", ")} (default provider)`)
            .option("--grain [width]", `Bucket width: ${GRAINS.join(" | ")} (default: hour up to 7 days, day above)`)
            .option("--heatmap", "Add the hour-by-weekday heatmap of average dollars")
            .option("--json", "Print usage.spend.pivot@1"),
        { since: "7d" }
    ).action(async (_opts: PivotOpts, command: Command) => {
        const opts = verbOpts<PivotOpts>(command);
        // The root's --harness (or --sources) narrows the spend read, as it does for the reports.
        const sources = harnessSources({ cmd: command, command: "pivot", ids: AGENT_IDS });

        if (sources === null) {
            return;
        }

        const by = splitList(typeof opts.by === "string" ? opts.by : undefined);
        const bad = by.find((dim) => !isPivotDimension(dim));

        if (opts.by === true || bad !== undefined) {
            out.printlnErr(
                suggestEnumFlag(TOOL, "--by", PIVOT_DIMENSIONS, {
                    subcommand: ["pivot"],
                    ...(bad ? { given: bad } : {}),
                })
            );
            process.exitCode = 1;
            return;
        }

        const grainGiven = typeof opts.grain === "string" ? opts.grain : undefined;

        if (opts.grain === true || (grainGiven !== undefined && !GRAINS.some((grain) => grain === grainGiven))) {
            out.printlnErr(
                suggestEnumFlag(TOOL, "--grain", GRAINS, {
                    subcommand: ["pivot"],
                    ...(grainGiven ? { given: grainGiven } : {}),
                })
            );
            process.exitCode = 1;
            return;
        }

        await guarded(async () => {
            const now = new Date();
            const window = resolveWindow(opts, { now, defaultSince: "7d" });
            const span = window.to.getTime() - window.from.getTime();
            const grain = GRAINS.find((value) => value === grainGiven) ?? (span <= 7 * 86_400_000 ? "hour" : "day");
            const directory = await accountDirectory();
            const events = await loadAttributedSpend({
                from: window.from,
                now,
                directory,
                ...(sources ? { sources } : {}),
            });
            const dims: PivotDimension[] = by.length > 0 ? by.filter(isPivotDimension) : ["provider"];
            const pivot = pivotSpend({
                events,
                from: window.from.getTime(),
                to: window.to.getTime(),
                grain,
                tz: window.tz,
                by: dims,
                heatmap: opts.heatmap === true,
            });
            const warnings: UsageWarning[] = dims.includes("account")
                ? [
                      {
                          code: "attribution-by-last-pin",
                          message: "Claude spend reaches an account only through its session's last pin.",
                      },
                  ]
                : [];

            await emit(
                usageEnvelope({ verb: "spend.pivot", version: 1, now, window, accounts: [], data: pivot, warnings }),
                opts.json,
                renderPivot
            );
        });
    });
}

interface PlansOpts {
    provider?: string[] | boolean;
    json?: boolean;
}

function renderPlans(envelope: UsageEnvelope<{ plans: PlanValue[] }>): void {
    renderCliHeader("Subscription value", "this billing cycle per subscription account");
    const table = createBoxTable([
        "ACCOUNT",
        "PLAN",
        "CYCLE",
        "SPEND",
        "PAID BACK",
        "CAPACITY USED",
        "$ / WEEKLY POINT",
    ]);

    for (const row of envelope.data.plans) {
        table.push([
            `${row.account.provider}/${row.account.accountName}`,
            row.plan ?? pc.dim("?"),
            `${row.cycle.from.slice(0, 10)}${row.cycle.guessed ? pc.dim(" (30 d)") : ` · renews in ${row.renewsInDays} d`}`,
            `${usd(row.spendUsd)}${row.approximate ? pc.dim(" (pins)") : ""}`,
            row.paidBackX === null ? pc.dim(row.price ? "not USD" : "no price") : `${row.paidBackX.toFixed(1)}x`,
            `${Math.round(row.capacityUsed * 100)}%`,
            row.usdPerWeeklyPoint === null ? pc.dim("—") : usd(row.usdPerWeeklyPoint),
        ]);
    }

    out.println(table.toString());
}

function registerPlans(program: Command): void {
    const plans = program
        .command("plans")
        .description(
            "Subscription value per billing cycle: list-price spend, capacity used, and the plan price paid back"
        )
        .option("--provider [name...]", "Only these providers")
        .option("--json", "Print usage.spend.plans@1")
        .action(async (_opts: PlansOpts, command: Command) => {
            const opts = command.optsWithGlobals<PlansOpts>();
            const sources = harnessSources({ cmd: command, command: "plans", ids: AGENT_IDS });

            if (sources === null) {
                return;
            }

            await guarded(async () => {
                const now = new Date();
                const providers = resolveProviderList(opts.provider);
                const snapshots = snapshotsFromCache(await readSnapshotsCache()).filter(
                    (snapshot) => providers === undefined || providers.includes(snapshot.provider)
                );
                const from = new Date(now.getTime() - 40 * 86_400_000);
                const config = await loadDashboardConfig({ readOnly: true });
                // A diagnostic read: no schema, no migration, no file.
                const db = UsageLimitsDb.readOnlyOrEmpty();
                let weekly: SeriesEntry[] = [];

                try {
                    weekly = db.getSeries({
                        from: from.toISOString(),
                        to: now.toISOString(),
                        agg: "raw",
                        step: 0,
                        kinds: ["weekly"],
                    });
                } finally {
                    db.close();
                }

                const events = await loadAttributedSpend({
                    from,
                    now,
                    directory: await accountDirectory(),
                    ...(sources ? { sources } : {}),
                });
                const rows = planValues({
                    snapshots,
                    events,
                    weekly: weekly.filter((entry) => entry.scopeModel === null),
                    providers: config.providers,
                    now,
                });
                const warnings: UsageWarning[] = rows.some((row) => row.price === null)
                    ? [
                          {
                              code: "no-plan-price",
                              message: `A plan has no price; set one with ${toolCommand("ai-spend plans price")} <provider> <plan> <amount>.`,
                          },
                      ]
                    : [];

                await emit(
                    usageEnvelope({
                        verb: "spend.plans",
                        version: 1,
                        now,
                        accounts: rows.map((row) => row.account),
                        data: { plans: rows },
                        warnings,
                    }),
                    opts.json,
                    renderPlans
                );
            });
        });

    plans
        .command("price <provider> <plan> <amount>")
        .description("Set a plan's price per billing cycle (the usage config's providers.<provider>.plans.<plan>)")
        .option("--currency <code>", "ISO currency of the amount", "USD")
        .action(async (provider: string, plan: string, amount: string, opts: { currency: string }) => {
            await guarded(async () => {
                const [plugin] = resolveProviderList([provider]) ?? [provider];
                const value = Number(amount);

                if (!Number.isFinite(value) || value < 0) {
                    throw new UsageQueryError("bad-value", `"${amount}" is not an amount.`, { given: amount });
                }

                const price = { priceMinor: Math.round(value * 100), currency: opts.currency.toUpperCase() };
                await updateDashboardConfig((stored) => {
                    const providers = stored.providers ?? {};
                    const current = providers[plugin] ?? {};
                    providers[plugin] = { ...current, plans: { ...current.plans, [plan]: price } };
                    stored.providers = providers;
                });
                logger.debug({ provider: plugin, plan, price }, "[ai-spend] plan price set");
                out.println(`${plugin} ${plan}: ${value.toFixed(2)} ${price.currency} per cycle`);
            });
        });
}

interface ProxyOpts {
    month?: string[];
    days?: string;
    json?: boolean;
}

function renderProxy(envelope: UsageEnvelope<ProxyReport>): void {
    renderCliHeader("ai-proxy", "booked cost per client and month · traffic per account and day");
    const clients = createBoxTable(["MONTH", "CLIENT", "REQUESTS", "TOKENS", "COST"]);

    for (const row of envelope.data.clients) {
        clients.push([row.month, row.client, String(row.requests), row.totalTokens.toLocaleString(), usd(row.costUsd)]);
    }

    out.println(clients.toString());
    const accounts = createBoxTable(["DAY", "ACCOUNT", "REQUESTS", "RATE LIMITED", "ERRORS", "CACHE READ"]);

    for (const row of envelope.data.accounts) {
        accounts.push([
            row.day,
            row.account,
            String(row.requests),
            row.rateLimited > 0 ? pc.yellow(String(row.rateLimited)) : "0",
            row.errors > 0 ? pc.red(String(row.errors)) : "0",
            row.cacheReadShare === null ? pc.dim("—") : `${Math.round(row.cacheReadShare * 100)}%`,
        ]);
    }

    out.println(accounts.toString());
}

function registerProxy(program: Command): void {
    program
        .command("proxy")
        .description(
            "What the ai-proxy served: booked cost per client and month, requests and rate limits per account and day"
        )
        .option("--month <months...>", "Only these months, YYYY-MM (default every month in the ledger)")
        .option("--days <n>", "Days of per-account traffic (default 14)")
        .option("--json", "Print usage.spend.proxy@1")
        .action(async (_opts: ProxyOpts, command: Command) => {
            const opts = command.optsWithGlobals<ProxyOpts>();

            await guarded(async () => {
                const now = new Date();
                const days = opts.days === undefined ? 14 : Number(opts.days);

                if (!Number.isInteger(days) || days < 1) {
                    throw new UsageQueryError("bad-value", `--days "${opts.days}" is not a positive whole number.`);
                }

                // `--days 14` is today and the 13 days before it.
                const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
                const months = opts.month && opts.month.length > 0 ? new Set(splitList(opts.month)) : undefined;
                const report = buildProxyReport({ ...(months ? { months } : {}), sinceDay: since });

                await emit(
                    usageEnvelope({ verb: "spend.proxy", version: 1, now, accounts: [], data: report }),
                    opts.json,
                    renderProxy
                );
            });
        });
}

/**
 * The verb's options with the root's: the root's `--since` default (30d, for the reports) is dropped, so a verb with
 * its own default window (7d) keeps it, and an alias (`--from`, `--hours`) is not refused as a second spelling.
 */
function verbOpts<T extends WindowFlags>(command: Command): T {
    const opts = { ...command.optsWithGlobals<T>() };

    if (command.getOptionValueSourceWithGlobals("since") === "default") {
        delete opts.since;
    }

    return opts;
}

interface WasteOpts extends WindowFlags {
    by?: string | boolean;
    top?: string;
    json?: boolean;
}

function renderWaste(envelope: UsageEnvelope<SpendWaste>): void {
    const waste = envelope.data;
    renderCliHeader(
        "Waste ledger",
        `${envelope.window?.label ?? ""} · ${usd(waste.total.usd)} avoidable in ${waste.total.items} cache rebuilds`
    );
    const table = createBoxTable([...waste.by.map((dim) => dim.toUpperCase()), "AVOIDABLE", "TOKENS", "ITEMS"]);

    for (const group of waste.groups.slice(0, 30)) {
        table.push([
            ...waste.by.map((dim) => truncateDisplay(group.key[dim] ?? "", 32)),
            usd(group.usd),
            group.tokens.toLocaleString(),
            String(group.items),
        ]);
    }

    out.println(table.toString());
    out.println(pc.bold("Top leaks"));

    for (const item of waste.top.slice(0, 5)) {
        out.println(
            `  ${usd(item.usd)} ${item.kind} ${item.agent} ${item.sessionId.slice(0, 8)} ${pc.dim(item.evidence)}`
        );
        out.println(`    ${pc.dim(item.next)}`);
    }
}

function registerWaste(program: Command): void {
    addWindowOptions(
        program
            .command("waste")
            .description(
                "Avoidable spend: every cache rebuild after an idle gap, a compaction or a model change, priced and rolled up"
            )
            .option("--by [dims]", `Comma list of: ${WASTE_DIMENSIONS.join(", ")} (default kind,account)`)
            .option("--top <n>", "How many of the costliest items to list (default 10)")
            .option("--json", "Print usage.spend.waste@1"),
        { since: "7d" }
    ).action(async (_opts: WasteOpts, command: Command) => {
        const opts = verbOpts<WasteOpts>(command);
        const sources = harnessSources({ cmd: command, command: "waste", ids: AGENT_IDS });

        if (sources === null) {
            return;
        }

        const by = splitList(typeof opts.by === "string" ? opts.by : undefined);
        const bad = by.find((dim) => !isWasteDimension(dim));

        if (opts.by === true || bad !== undefined) {
            out.printlnErr(
                suggestEnumFlag(TOOL, "--by", WASTE_DIMENSIONS, {
                    subcommand: ["waste"],
                    ...(bad ? { given: bad } : {}),
                })
            );
            process.exitCode = 1;
            return;
        }

        await guarded(async () => {
            const now = new Date();
            const window = resolveWindow(opts, { now, defaultSince: "7d" });
            const top = opts.top === undefined ? 10 : Number(opts.top);

            if (!Number.isInteger(top) || top < 1) {
                throw new UsageQueryError("bad-value", `--top "${opts.top}" is not a positive whole number.`);
            }

            const events = await loadAttributedSpend({
                from: window.from,
                now,
                directory: await accountDirectory(),
                ...(sources ? { sources } : {}),
            });
            const dims: WasteDimension[] = by.length > 0 ? by.filter(isWasteDimension) : ["kind", "account"];
            const waste = await scanSpendWaste({
                events,
                from: window.from.getTime(),
                to: window.to.getTime(),
                by: dims,
                tz: window.tz,
                reportCommand: aiSessionReportCommand,
                top,
            });
            const warnings: UsageWarning[] =
                waste.sessions.unsupported > 0
                    ? [
                          {
                              code: "unsupported",
                              message: `${waste.sessions.unsupported} transcripts give no call trace.`,
                          },
                      ]
                    : [];

            await emit(
                usageEnvelope({ verb: "spend.waste", version: 1, now, window, accounts: [], data: waste, warnings }),
                opts.json,
                renderWaste
            );
        });
    });
}

export function registerSpendVerbs(program: Command): void {
    registerPivot(program);
    registerPlans(program);
    registerProxy(program);
    registerWaste(program);
}
