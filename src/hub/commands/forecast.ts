import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { buildForecast, type WindowForecast } from "../lib/forecast";

function clock(iso: string | null): string {
    if (!iso) {
        return "";
    }

    const date = new Date(iso);
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
        ? date.toTimeString().slice(0, 5)
        : `${date.toDateString().slice(0, 10)} ${date.toTimeString().slice(0, 5)}`;
}

function outlook(window: WindowForecast): string {
    if (window.resetSinceSample) {
        return formatDotStatus("dim", "reset since the last sample");
    }

    if (!window.exhaustAt) {
        return formatDotStatus("ok", "no burn in this window");
    }

    const text = `out ${clock(window.exhaustAt)} · ${window.projectedAtReset ?? "?"}% at reset`;
    return formatDotStatus(window.beforeReset ? "err" : "ok", text);
}

export function registerForecastCommand(program: Command): void {
    program
        .command("forecast")
        .description(
            "When each AI account's 5-hour and weekly windows run out at the recent burn rate (reads recorded usage snapshots only, never fetches)"
        )
        .option("--provider <id>", "only this usage provider (anthropic-sub, openai-sub, grok-sub)")
        .option("--account <name>", "only this account")
        .option("--json", "machine-readable output (the hub reads this)")
        .action(async (opts: { provider?: string; account?: string; json?: boolean }) => {
            const result = await buildForecast({ provider: opts.provider, account: opts.account });

            if (opts.json) {
                out.result(result);
                return;
            }

            renderCliHeader("Usage forecast", "at the recent burn rate");

            if (result.accounts.length === 0) {
                out.println(
                    result.source
                        ? "No usage snapshots in the last 8 days (the usage poller records them: tools ai usage)."
                        : "No history database yet."
                );
                return;
            }

            const table = createBoxTable(["ACCOUNT", "WINDOW", "USED", "RATE", "RESETS", "OUTLOOK"]);

            for (const account of result.accounts) {
                for (const window of account.windows) {
                    table.push([
                        `${account.account}\n${pc.dim(account.provider)}`,
                        window.label,
                        `${window.utilization.toFixed(0)}%${window.stale ? pc.yellow(" (old)") : ""}`,
                        window.ratePctPerHour === null
                            ? ""
                            : `${window.ratePctPerHour}%/h ${pc.dim(window.basis ?? "")}`,
                        clock(window.resetsAt),
                        outlook(window),
                    ]);
                }
            }

            out.println(table.toString());
            out.println(pc.dim(`${result.accounts.length} accounts · ${result.elapsedMs} ms · ${result.source}`));
        });
}
