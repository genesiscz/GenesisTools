import { type EventsData, type EventsOptions, queryEvents } from "@app/ai/lib/usage/events-query";
import { usageProviderValues } from "@app/ai/lib/usage/provider-values";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { addReservedHarnessOption, addWindowOptions, type UsageEnvelope } from "@genesiscz/utils/ai/usage/contract";
import { USAGE_EVENT_KINDS, type UsageEventRow } from "@genesiscz/utils/ai/usage/events/store";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { emit, guarded, printWarnings } from "./limits";

function retryCell(row: UsageEventRow): string {
    if (row.kind === "probe") {
        return `${row.count} on ${row.day}`;
    }

    return row.retryAfterMs === null ? pc.dim("—") : `${Math.round(row.retryAfterMs / 1000)} s`;
}

function renderEvents(envelope: UsageEnvelope<EventsData>): void {
    const counts = Object.entries(envelope.data.counts)
        .map(([kind, count]) => `${kind} ${count}`)
        .join(" · ");
    renderCliHeader("Usage events", `${envelope.window?.label ?? ""} · ${counts || "none"}`);
    const table = createBoxTable(["WHEN", "KIND", "ACCOUNT", "SOURCE", "WAIT / COUNT", "DETAIL"]);

    for (const row of envelope.data.events) {
        table.push([
            new Date(row.ts).toLocaleString(),
            row.kind,
            `${providerAliasOf(row.provider)}/${row.accountName ?? row.accountId ?? "?"}`,
            row.source,
            retryCell(row),
            truncateDisplay([row.model, row.detail].filter(Boolean).join(" · "), 50),
        ]);
    }

    out.println(table.toString());
    printWarnings(envelope.warnings);
}

/**
 * `tools ai usage events` (design 2026-11-01, step U6, proposal 15): rate-limit answers, cooldowns, poll-gate pauses,
 * org blocks, refused probes and daily probe counts, newest first; `--json` prints `usage.events@1`.
 */
export function registerAiUsageEventsCommand(usage: Command): void {
    const events = addWindowOptions(
        usage
            .command("events")
            .description(
                "Rate-limit answers, cooldowns, poll pauses, org blocks and quota probes; --json prints usage.events@1"
            )
            .option("--provider [list...]", `Limit to these providers: ${usageProviderValues().join(" | ")}`)
            .option("--account <list...>", "Accounts by exact id or name, proxy account names included")
            .option("--json", "Print the JSON envelope"),
        { since: "24h" }
    )
        .option("--kind [kinds...]", `Only these kinds: ${USAGE_EVENT_KINDS.join(" | ")}`)
        .option("--limit <n>", "At most this many events, newest first");

    addReservedHarnessOption(events).action(async (_opts: EventsOptions, command: Command) => {
        await guarded(["events"], async () => {
            const opts = command.optsWithGlobals<EventsOptions>();
            await emit(await queryEvents(opts), opts.json, renderEvents);
        });
    });
}
