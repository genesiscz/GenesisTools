import {
    type BudgetEdit,
    type BudgetEditOptions,
    type BudgetsData,
    type BudgetsListOptions,
    queryBudgets,
    removeBudget,
    setBudget,
} from "@app/ai/lib/usage/budgets-query";
import { BUDGET_WINDOW_KINDS } from "@genesiscz/utils/ai/usage/budgets/budgets";
import { addReservedHarnessOption, type UsageEnvelope } from "@genesiscz/utils/ai/usage/contract";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { accountLabel, addSelectorOptions, emit, guarded, printWarnings } from "./limits";

const STATUS_COLOR = {
    "on-pace": pc.green,
    "over-pace": pc.yellow,
    "under-reserve": pc.red,
    "no-target": pc.dim,
} as const;

function renderBudgets(envelope: UsageEnvelope<BudgetsData>): void {
    renderCliHeader("Usage budgets", "window targets with today's pace, spend targets with today's spend");

    if (envelope.data.windows.length > 0) {
        const table = createBoxTable(["ACCOUNT", "WINDOW", "USED", "RESERVE", "TODAY / ALLOWANCE", "STATUS"]);

        for (const row of envelope.data.windows) {
            const today =
                row.pace.allowancePct === null
                    ? pc.dim("—")
                    : `${row.pace.burnedTodayPct?.toFixed(1)} / ${row.pace.allowancePct.toFixed(1)}`;
            table.push([
                accountLabel(row),
                row.label,
                `${row.utilization.toFixed(0)}%`,
                `${row.pace.reservePct}%`,
                today,
                STATUS_COLOR[row.pace.status](row.pace.status),
            ]);
        }

        out.println(table.toString());
    }

    if (envelope.data.spend.length > 0) {
        const table = createBoxTable(["SCOPE", "TODAY", "DAILY TARGET", "SHARE"]);

        for (const row of envelope.data.spend) {
            table.push([
                row.scope,
                `$${row.todayUsd.toFixed(2)}`,
                `$${row.dailyUsd.toFixed(2)}`,
                `${Math.round(row.ratio * 100)}%`,
            ]);
        }

        out.println(table.toString());
    }

    printWarnings(envelope.warnings);
}

function printEdit(verb: string, edit: BudgetEdit): void {
    out.println(`${verb} ${edit.target}${edit.budget ? ` ${pc.dim(SafeJSON.stringify(edit.budget))}` : ""}`);
}

/**
 * `tools ai usage budgets list | set | rm` (design 2026-11-01, step U10, proposal 18). The targets live in the usage
 * dashboard config under `budgets`, nested by provider and immutable account id; the `budget` alert rule reads them.
 */
export function registerAiUsageBudgetsCommands(usage: Command): void {
    const budgets = usage.command("budgets").description("Window and spend targets: list | set | rm");

    addReservedHarnessOption(
        addSelectorOptions(
            budgets
                .command("list", { isDefault: true })
                .description("Every target with today's pace and spend; --json prints usage.budgets@1")
        )
    ).action(async (_opts: BudgetsListOptions, command: Command) => {
        await guarded(["budgets", "list"], async () => {
            const opts = command.optsWithGlobals<BudgetsListOptions>();
            await emit(await queryBudgets(opts), opts.json, renderBudgets);
        });
    });

    budgets
        .command("set")
        .description("Set a window target (--account --kind --reserve/--daily) or a spend target (--spend-daily)")
        .option("--account <name...>", "The one account the window target is for")
        .option("--kind [kind]", `The window: ${BUDGET_WINDOW_KINDS.join(" | ")}`)
        .option("--reserve <pct>", "Keep this many percent of the window at its reset")
        .option("--daily <pct>", "Use at most this many percent of the window per local day")
        .option("--spend-daily <usd>", "A spend target in dollars per local day (with --provider: that provider only)")
        .option("--provider [name...]", "The provider of a spend target")
        .action(async (_opts: BudgetEditOptions, command: Command) => {
            await guarded(["budgets", "set"], async () => {
                printEdit("set", await setBudget(command.optsWithGlobals<BudgetEditOptions>()));
            });
        });

    budgets
        .command("rm")
        .description("Remove a window target (--account --kind) or a spend target (--spend [--provider])")
        .option("--account <name...>", "The account of the window target")
        .option("--kind [kind]", `The window: ${BUDGET_WINDOW_KINDS.join(" | ")}`)
        .option("--spend", "Remove the spend target instead")
        .option("--provider [name...]", "The provider of a spend target")
        .action(async (_opts: BudgetEditOptions, command: Command) => {
            await guarded(["budgets", "rm"], async () => {
                printEdit("removed", await removeBudget(command.optsWithGlobals<BudgetEditOptions>()));
            });
        });
}
