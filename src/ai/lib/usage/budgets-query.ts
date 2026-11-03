import type { Database } from "bun:sqlite";
import { openHistoryReadOnly } from "@genesiscz/utils/agent-sessions/database";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { notifiableWindows } from "@genesiscz/utils/ai/usage/alerts/windows";
import { type AttributedEvent, loadAttributedSpend } from "@genesiscz/utils/ai/usage/attribution";
import {
    BUDGET_WINDOW_KINDS,
    type BudgetPace,
    type BudgetWindowKind,
    isBudgetWindowKind,
    localDayStart,
    type UsageBudgets,
    type WindowBudget,
    windowBudgetFor,
    windowPace,
} from "@genesiscz/utils/ai/usage/budgets/budgets";
import {
    type AccountKey,
    refuseHarness,
    resolveProviderList,
    selectAccounts,
    type UsageEnvelope,
    UsageQueryError,
    type UsageWarning,
    usageEnvelope,
} from "@genesiscz/utils/ai/usage/contract";
import { readSampleSeeds, readUsageSamples, type UsageSample } from "@genesiscz/utils/ai/usage/forecast/samples";
import {
    loadDashboardConfig,
    type UsageDashboardConfig,
    updateDashboardConfig,
} from "@genesiscz/utils/ai/usage-poll/dashboard-config";
import { readSnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { snapshotsFromCache, usageAccountKeys } from "@genesiscz/utils/ai/usage-poll/limits-now";
import { usagePlugins } from "@genesiscz/utils/ai/usage-poll/poll";
import { logger } from "@genesiscz/utils/logger";

/** `usage.budgets@1`. */
export const USAGE_BUDGETS_SCHEMA = { verb: "budgets", version: 1 } as const;

export interface BudgetWindowRow extends AccountKey {
    kind: BudgetWindowKind;
    key: string;
    label: string;
    utilization: number;
    resetsAt: string | null;
    budget: WindowBudget;
    pace: BudgetPace;
}

export interface SpendBudgetRow {
    /** `global`, or a plugin id. */
    scope: string;
    dailyUsd: number;
    todayUsd: number;
    ratio: number;
}

export interface BudgetsData {
    budgets: UsageBudgets;
    windows: BudgetWindowRow[];
    spend: SpendBudgetRow[];
}

export interface BudgetsListOptions {
    provider?: string[] | boolean;
    account?: string[];
    json?: boolean;
    harness?: string[] | boolean;
}

export interface BudgetsListDeps {
    now?: Date;
    config?: () => Promise<UsageDashboardConfig>;
    open?: () => Database | undefined;
    todaySpend?: (from: Date, now: Date) => Promise<readonly AttributedEvent[]>;
}

function spendRows(budgets: UsageBudgets, events: readonly AttributedEvent[]): SpendBudgetRow[] {
    const rows: SpendBudgetRow[] = [];
    const total = events.reduce((sum, event) => sum + event.costUsd, 0);
    const row = (scope: string, dailyUsd: number, todayUsd: number): SpendBudgetRow => ({
        scope,
        dailyUsd,
        todayUsd,
        ratio: dailyUsd > 0 ? todayUsd / dailyUsd : 0,
    });

    if (budgets.global.spend?.dailyUsd !== undefined) {
        rows.push(row("global", budgets.global.spend.dailyUsd, total));
    }

    for (const [provider, entry] of Object.entries(budgets.providers)) {
        if (entry.spend?.dailyUsd !== undefined) {
            const spent = events.filter((event) => event.provider === provider).reduce((sum, e) => sum + e.costUsd, 0);
            rows.push(row(provider, entry.spend.dailyUsd, spent));
        }
    }

    return rows;
}

/**
 * `tools ai usage budgets list` (design 2026-11-01, step U10, proposal 18): every budgeted window with today's pace,
 * and every spend target with today's spend. A diagnostic: it reads the config, the last poll's snapshots and a
 * read-only store connection, and writes nothing.
 */
export async function queryBudgets(
    opts: BudgetsListOptions,
    deps: BudgetsListDeps = {}
): Promise<UsageEnvelope<BudgetsData>> {
    refuseHarness(opts.harness);

    const now = deps.now ?? new Date();
    const dayStart = localDayStart(now);
    const config = await (deps.config ?? (() => loadDashboardConfig({ readOnly: true })))();
    const providers = resolveProviderList(opts.provider);
    const providerIds = providers ?? usagePlugins().map((entry) => entry.plugin.id);
    // The shared selector: ids, provider/name, a unique name fragment and comma lists; unknown or ambiguous refuses.
    const directory = usageAccountKeys((await AiConfigStore.readOnly()).accounts(), providerIds, {
        visibleOnly: false,
    });
    const selection = selectAccounts(opts.account, directory);
    const wanted = selection && new Set(selection.map((key) => `${key.provider}\u0000${key.accountId}`));
    const snapshots = snapshotsFromCache(await readSnapshotsCache()).filter(
        (snapshot) =>
            (providers === undefined || providers.includes(snapshot.provider)) &&
            (!wanted || wanted.has(`${snapshot.provider}\u0000${snapshot.accountId}`))
    );
    const db = (deps.open ?? (() => openHistoryReadOnly()))();
    let samples: UsageSample[] = [];

    try {
        // The readings of the last day, after each window's last reading before them: a window idle for days still
        // has its value at midnight, instead of 0 and its whole utilization read as today's burn.
        const since = new Date(dayStart.getTime() - 86_400_000);
        samples = db ? [...readSampleSeeds(db, { before: since }), ...readUsageSamples(db, { since })] : [];
    } finally {
        db?.close();
    }

    const windows: BudgetWindowRow[] = [];

    for (const window of notifiableWindows(snapshots)) {
        const budget = windowBudgetFor(config.budgets, window);

        if (!budget || !isBudgetWindowKind(window.kind)) {
            continue;
        }

        windows.push({
            provider: window.provider,
            accountId: window.accountId,
            accountName: window.accountName,
            kind: window.kind,
            key: window.key,
            label: window.label,
            utilization: window.utilization,
            resetsAt: window.resetsAt,
            budget,
            pace: windowPace({
                budget,
                kind: window.kind,
                utilization: window.utilization,
                resetsAt: window.resetsAt,
                samples: samples
                    .filter(
                        (sample) =>
                            sample.provider === window.provider &&
                            sample.account === window.accountName &&
                            sample.bucket === window.key
                    )
                    .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
                now,
                dayStart,
                overPaceFactor: config.alerts.rules.budget.overPaceFactor,
            }),
        });
    }

    const wantsSpend =
        config.budgets.global.spend?.dailyUsd !== undefined ||
        Object.values(config.budgets.providers).some((entry) => entry.spend?.dailyUsd !== undefined);
    const events = wantsSpend
        ? await (deps.todaySpend ?? ((from, at) => loadAttributedSpend({ from, now: at, directory: [] })))(
              dayStart,
              now
          )
        : [];
    const warnings: UsageWarning[] = [];

    if (windows.length === 0 && !wantsSpend) {
        warnings.push({ code: "no-budgets", message: "No budget is set. Add one with budgets set." });
    }

    logger.debug({ windows: windows.length, spend: wantsSpend }, "[ai-usage] budgets list");

    return usageEnvelope({
        ...USAGE_BUDGETS_SCHEMA,
        now,
        accounts: windows,
        data: {
            budgets: config.budgets,
            windows,
            spend: spendRows(
                config.budgets,
                events.filter((event) => event.at >= dayStart.getTime())
            ),
        },
        warnings,
    });
}

export interface BudgetEditOptions {
    account?: string[];
    provider?: string[] | boolean;
    kind?: string | boolean;
    reserve?: string;
    daily?: string;
    spendDaily?: string;
    spend?: boolean;
}

function percent(flag: string, raw: string | undefined): number | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const value = Number(raw);

    if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new UsageQueryError("bad-value", `${flag} "${raw}" is not a percent from 0 to 100.`, { given: raw });
    }

    return value;
}

function resolveKind(raw: string | boolean | undefined): BudgetWindowKind {
    const enumFlag = { flag: "--kind", values: BUDGET_WINDOW_KINDS };

    if (typeof raw !== "string" || !isBudgetWindowKind(raw)) {
        throw new UsageQueryError("bad-value", `--kind takes ${BUDGET_WINDOW_KINDS.join(" | ")}.`, {
            ...(typeof raw === "string" ? { given: raw } : {}),
            enumFlag,
        });
    }

    return raw;
}

async function oneAccount(values: string[] | undefined): Promise<AccountKey> {
    const store = await AiConfigStore.readOnly();
    const directory = usageAccountKeys(
        store.accounts(),
        usagePlugins().map((entry) => entry.plugin.id),
        { visibleOnly: false }
    );
    const picked = selectAccounts(values, directory) ?? [];

    if (picked.length !== 1) {
        throw new UsageQueryError("bad-value", "--account must name exactly one account.");
    }

    return picked[0];
}

function oneProvider(raw: string[] | boolean | undefined): string | undefined {
    const list = resolveProviderList(raw);

    if (list !== undefined && list.length !== 1) {
        throw new UsageQueryError("bad-value", "--provider takes one provider here.");
    }

    return list?.[0];
}

/** What `budgets set` or `budgets rm` changed, for the line the command prints. */
export interface BudgetEdit {
    target: string;
    budget: WindowBudget | { dailyUsd: number } | null;
}

/**
 * `tools ai usage budgets set`: a window target (`--account --kind --reserve/--daily`) or a spend target
 * (`--spend-daily [--provider]`). Written through the config store's lock; every other key stays as it was.
 */
export async function setBudget(opts: BudgetEditOptions): Promise<BudgetEdit> {
    if (opts.spendDaily !== undefined) {
        const dailyUsd = Number(opts.spendDaily);

        if (!Number.isFinite(dailyUsd) || dailyUsd <= 0) {
            throw new UsageQueryError("bad-value", `--spend-daily "${opts.spendDaily}" is not a positive amount.`);
        }

        const provider = oneProvider(opts.provider);
        await updateDashboardConfig((stored) => {
            const budgets: UsageBudgets = {
                global: stored.budgets?.global ?? {},
                providers: stored.budgets?.providers ?? {},
            };

            if (provider === undefined) {
                budgets.global.spend = { dailyUsd };
            } else {
                budgets.providers[provider] = { ...budgets.providers[provider], spend: { dailyUsd } };
            }

            stored.budgets = budgets;
        });

        return { target: provider ?? "global", budget: { dailyUsd } };
    }

    const kind = resolveKind(opts.kind);
    const reservePct = percent("--reserve", opts.reserve);
    const dailyAllowancePct = percent("--daily", opts.daily);

    // A session window has no daily allowance (`windowPace` answers no-target), so the target could never alert.
    if (kind === "session" && dailyAllowancePct !== undefined) {
        throw new UsageQueryError("bad-value", "--daily does not apply to a session window; give it --reserve <pct>.");
    }

    if (reservePct === undefined && dailyAllowancePct === undefined) {
        throw new UsageQueryError(
            "bad-value",
            "budgets set needs --reserve <pct>, --daily <pct> or --spend-daily <usd>."
        );
    }

    const account = await oneAccount(opts.account);
    const budget: WindowBudget = {
        ...(reservePct === undefined ? {} : { reservePct }),
        ...(dailyAllowancePct === undefined ? {} : { dailyAllowancePct }),
    };

    await updateDashboardConfig((stored) => {
        const budgets: UsageBudgets = {
            global: stored.budgets?.global ?? {},
            providers: stored.budgets?.providers ?? {},
        };
        const provider = budgets.providers[account.provider] ?? {};
        const accounts = provider.accounts ?? {};
        accounts[account.accountId] = {
            ...accounts[account.accountId],
            [kind]: { ...accounts[account.accountId]?.[kind], ...budget },
        };
        budgets.providers[account.provider] = { ...provider, accounts };
        stored.budgets = budgets;
    });

    return { target: `${account.provider}/${account.accountName} ${kind}`, budget };
}

/** `tools ai usage budgets rm`: removes one window target or one spend target. */
export async function removeBudget(opts: BudgetEditOptions): Promise<BudgetEdit> {
    if (opts.spend) {
        const provider = oneProvider(opts.provider);
        await updateDashboardConfig((stored) => {
            if (provider === undefined) {
                delete stored.budgets?.global?.spend;
            } else {
                delete stored.budgets?.providers?.[provider]?.spend;
            }
        });

        return { target: provider ?? "global", budget: null };
    }

    const kind = resolveKind(opts.kind);
    const account = await oneAccount(opts.account);
    await updateDashboardConfig((stored) => {
        delete stored.budgets?.providers?.[account.provider]?.accounts?.[account.accountId]?.[kind];
    });

    return { target: `${account.provider}/${account.accountName} ${kind}`, budget: null };
}
