import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import {
    filterRmLedger,
    isRmLedgerGroup,
    ledgerAgent,
    RM_LEDGER_GROUPS,
    readRmLedger,
    totalRmLedger,
} from "@genesiscz/utils/rm";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { minutesOption, shown } from "../lib/run";

interface LogFlags {
    since?: number;
    agent?: string;
    session?: string;
    action?: string;
    path?: string;
    by?: string;
    limit: number;
    json?: boolean;
}

function localTime(at: string): string {
    const date = new Date(at);
    return `${date.toLocaleDateString("sv-SE")} ${date.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`;
}

export function registerAuditCommands(program: Command): void {
    program
        .command("log")
        .description("the audit log: every move, aside, drain, restore, refusal and decision, with who did it")
        .option("--since <duration>", "only the last 30m, 2h, 1d, ...", minutesOption)
        .option("--agent <name>", "claude-code, codex, grok, copilot, or person")
        .option("--session <id>", "a session id or its prefix")
        .option("--action <list>", "comma list: move, aside, return, drain, restore, refuse, request, approve, deny")
        .option("--path <text>", "entries whose path contains this text")
        .option("--by <group>", `totals instead of entries: ${RM_LEDGER_GROUPS.join(", ")}`)
        .option("--limit <n>", "how many entries to print (newest)", (v) => Number.parseInt(v, 10), 50)
        .option("--json", "print as JSON")
        .action((flags: LogFlags) => {
            const entries = filterRmLedger(readRmLedger(), {
                since: flags.since === undefined ? undefined : new Date(Date.now() - flags.since * 60_000),
                agent: flags.agent,
                session: flags.session,
                actions: flags.action?.split(",").map((a) => a.trim()),
                path: flags.path,
            });

            if (flags.by !== undefined) {
                if (!isRmLedgerGroup(flags.by)) {
                    out.println(pc.red(`--by takes one of: ${RM_LEDGER_GROUPS.join(", ")}`));
                    process.exitCode = 1;
                    return;
                }

                const totals = totalRmLedger(entries, flags.by);

                if (flags.json) {
                    out.result(totals);
                    return;
                }

                const table = createBoxTable([
                    flags.by.toUpperCase(),
                    "MOVED",
                    "ASIDE",
                    "RECLAIMED",
                    "ITEMS",
                    "REFUSED",
                    "ASKED",
                ]);

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

            const newest = entries.slice(-flags.limit);

            if (flags.json) {
                out.result(newest);
                return;
            }

            if (newest.length === 0) {
                out.println("No entries.");
                return;
            }

            const cwd = process.cwd();

            for (const entry of newest) {
                const caller = entry.caller;
                const who = [
                    ledgerAgent(entry),
                    caller?.sessionId?.slice(0, 8),
                    caller?.sessionTitle ? `"${truncateDisplay(caller.sessionTitle, 30)}"` : undefined,
                    caller?.model ?? undefined,
                    caller && !caller.isInAgent ? caller.user : undefined,
                ]
                    .filter(Boolean)
                    .join(" ");
                const size = entry.bytes === undefined ? "" : ` ${formatBytes(entry.bytes)}`;
                const subject = entry.path ? shown(entry.path, cwd) : (entry.requestId ?? "");
                const extra = entry.rule ? pc.dim(` ${entry.rule}`) : "";
                out.println(
                    `${pc.dim(localTime(entry.at))} ${pc.bold(entry.action.padEnd(8))}${size} ${subject}${extra}`
                );
                out.println(pc.dim(`                 ${who}${entry.via ? ` via ${entry.via}` : ""}`));
            }

            if (entries.length > newest.length) {
                out.println(pc.dim(`${entries.length - newest.length} older entries hidden (--limit).`));
            }
        });
}
