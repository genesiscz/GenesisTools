import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import {
    filterRmLedger,
    isRmLedgerGroup,
    RM_LEDGER_GROUPS,
    type RmLedgerFilter,
    readRmLedger,
    readRmLedgerNewest,
    totalRmLedger,
} from "@genesiscz/utils/rm";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { renderLedger } from "../lib/log-view";
import { minutesOption } from "../lib/run";

interface LogFlags {
    since?: number;
    agent?: string;
    session?: string;
    action?: string;
    path?: string;
    by?: string;
    limit: number;
    each?: boolean;
    json?: boolean;
}

export function registerAuditCommands(program: Command): void {
    program
        .command("log")
        .description("the audit log: every move, aside, drain, restore, refusal and decision, with who did it")
        .option("--since <duration>", "only the last 30m, 2h, 1d, ...", minutesOption)
        .option("--agent <name>", "claude-code, codex, grok, copilot, or person")
        .option("--session <id>", "a session id or its prefix")
        .option(
            "--action <list>",
            "comma list: move, aside, measure, return, drain, restore, refuse, request, approve, deny"
        )
        .option("--path <text>", "entries whose path contains this text")
        .option("--by <group>", `totals instead of entries: ${RM_LEDGER_GROUPS.join(", ")}`)
        .option("--limit <n>", "how many entries to print (newest)", (v) => Number.parseInt(v, 10), 50)
        .option("--each", "one row per entry, instead of one per run that shares action, batch and caller")
        .option("--json", "print as JSON")
        .action((flags: LogFlags) => {
            const filter: RmLedgerFilter = {
                since: flags.since === undefined ? undefined : new Date(Date.now() - flags.since * 60_000),
                agent: flags.agent,
                session: flags.session,
                actions: flags.action?.split(",").map((a) => a.trim()),
                path: flags.path,
            };

            if (flags.by !== undefined) {
                if (!isRmLedgerGroup(flags.by)) {
                    out.println(pc.red(`--by takes one of: ${RM_LEDGER_GROUPS.join(", ")}`));
                    process.exitCode = 1;
                    return;
                }

                // Totals cover every matching entry, so they read the whole ledger; the entry view below does not.
                const totals = totalRmLedger(filterRmLedger(readRmLedger(), filter), flags.by);

                if (flags.json) {
                    out.result(totals);
                    return;
                }

                const table = createBoxTable(
                    [flags.by.toUpperCase(), "MOVED", "ASIDE", "RECLAIMED", "ITEMS", "REFUSED", "ASKED"],
                    { rowRules: false }
                );

                for (const t of totals) {
                    table.push([
                        truncateDisplay(t.key, 50),
                        formatBytes(t.moved),
                        formatBytes(t.aside),
                        formatBytes(t.reclaimed),
                        String(t.items),
                        String(t.refused),
                        String(t.requests),
                    ]);
                }

                out.println(table.toString());
                return;
            }

            // One more than shown, so the note below knows older entries exist without reading them all.
            const read = readRmLedgerNewest(filter, flags.limit + 1);
            const newest = read.slice(-flags.limit);

            if (flags.json) {
                out.result(newest);
                return;
            }

            if (newest.length === 0) {
                out.println("No entries.");
                return;
            }

            for (const line of renderLedger(newest, { cwd: process.cwd(), each: flags.each })) {
                out.println(line);
            }

            if (read.length > newest.length) {
                out.println(pc.dim("Older entries hidden (--limit)."));
            }
        });
}
