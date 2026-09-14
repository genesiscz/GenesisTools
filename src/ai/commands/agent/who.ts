import { accountEnvVar } from "@genesiscz/utils/ai/account-env";
import { type ActiveAgentProcess, listActiveAgentProcesses } from "@genesiscz/utils/ai/active-processes";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { collapsePath } from "@genesiscz/utils/paths";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

/**
 * `tools <agent> who`: live processes of one coding agent, and the account each one bills.
 *
 * This shipped for Claude alone while the codex and grok launchers already exported their
 * account env var, so the information was on the process table and nothing read it. A
 * DIAGNOSTIC — it reads `ps` and `lsof`, and touches no credential.
 *
 * Claude keeps its own richer `who` (session ids, cmux surfaces, the last message), which is
 * enrichment over the same scan rather than a second scan.
 */

export interface AgentWhoOptions {
    alias: AccountProviderAlias;
    /** `tools codex`, for the header line. */
    tool: string;
    /** The process kind, or null when this `ps` line is not this agent. */
    classify(args: string): string | null;
    /** Kinds that are helpers rather than sessions, hidden unless `--all`. */
    helperKinds?: readonly string[];
}

function accountCell(process: ActiveAgentProcess): string {
    if (process.proxyTarget) {
        return pc.cyan(`proxy:${process.proxyTarget}`);
    }

    if (process.account) {
        return pc.yellow(process.account);
    }

    return pc.dim("native?");
}

function startedCell(process: ActiveAgentProcess): string {
    if (!process.startedAt) {
        return pc.dim("—");
    }

    return formatRelativeTime(new Date(process.startedAt), { compact: true });
}

export function registerAgentWhoCommand(program: Command, options: AgentWhoOptions): Command {
    const helpers = new Set(options.helperKinds ?? []);

    return program
        .command("who")
        .alias("active")
        .description(
            `List live ${options.alias} processes with the account each one runs as ` +
                `(read from ${accountEnvVar(options.alias)} in the process env; ` +
                `'native?' = launched outside tools ${options.alias} run)`
        )
        .option("--json", "Machine-readable output")
        .option("--all", "Include helper processes")
        .action(async (flags: { json?: boolean; all?: boolean }) => {
            const all = await listActiveAgentProcesses({ alias: options.alias, classify: options.classify });
            const processes = (flags.all ? all : all.filter((entry) => !helpers.has(entry.kind))).sort((a, b) =>
                `${a.account ?? "~"}\0${a.startedAt ?? 0}`.localeCompare(`${b.account ?? "~"}\0${b.startedAt ?? 0}`)
            );

            if (flags.json) {
                out.result({ sessions: processes });
                return;
            }

            if (processes.length === 0) {
                out.println(pc.dim(`No live ${options.alias} processes.`));
                return;
            }

            renderCliHeader(`Active ${options.alias} processes`, "live processes and the account each one bills");

            const table = createBoxTable(["ACCOUNT", "PID", "KIND", "CWD", "STARTED", "TTY"]);

            for (const entry of processes) {
                table.push([
                    accountCell(entry),
                    String(entry.pid),
                    entry.kind === "tui" ? entry.kind : pc.dim(entry.kind),
                    pc.dim(truncateDisplay(entry.cwd ? collapsePath(entry.cwd) : "", 40)),
                    startedCell(entry),
                    entry.tty === "??" ? pc.dim("—") : entry.tty,
                ]);
            }

            out.println(table.toString());

            const counts = new Map<string, number>();

            for (const entry of processes) {
                const key = entry.proxyTarget ? `proxy:${entry.proxyTarget}` : (entry.account ?? "native?");
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }

            const summary = [...counts.entries()].map(([name, count]) => `${name} ${count}`).join(" · ");
            out.println(pc.dim(`  ${processes.length} process${processes.length === 1 ? "" : "es"}  ·  ${summary}`));

            const hidden = all.length - processes.length;

            if (hidden > 0) {
                out.println(pc.dim(`  ${hidden} helper process${hidden === 1 ? "" : "es"} hidden — show with --all.`));
            }
        });
}
