import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { Command } from "commander";
import pc from "picocolors";
import { discoverTeams } from "../lib/teams/discover";
import { printTeamsList, runTeamsInteractive } from "../lib/teams/ui";

interface TeamsFlags {
    all?: boolean;
    json?: boolean;
    account?: string;
    watch?: boolean;
}

export function registerTeamsCommand(program: Command): void {
    program
        .command("teams")
        .description(
            "List Claude Code agent teams and re-attach teammates with OAuth " +
                "(focus live pane, split lead tmux, or launch tools cc run -- --agent-id …). " +
                "Default: current project; use --all for every team."
        )
        .option("--all", "Include teams from all projects, not just cwd")
        .option("--json", "Machine-readable dump (no interactive UI)")
        .option("--account <name>", "Account for tools cc run when launching a teammate")
        .option("--watch", "Non-interactive: re-print the tree every 2s (Ctrl+C to stop)")
        .action(async (flags: TeamsFlags) => {
            await runTeams(flags);
        });
}

async function runTeams(flags: TeamsFlags): Promise<void> {
    const prof = profiler.scope("teams");

    if (flags.json) {
        const teams = discoverTeams({ all: flags.all });
        out.result(
            teams.map((t) => ({
                teamName: t.teamName,
                leadSessionId: t.leadSessionId,
                cwd: t.cwd,
                tmuxSession: t.tmuxSession,
                mtimeMs: t.mtimeMs,
                teammates: t.teammates.map((m) => ({
                    name: m.member.name,
                    agentId: m.member.agentId,
                    model: m.member.model,
                    status: m.status,
                    backend: m.backend,
                    activity: m.activity,
                    live: m.live
                        ? {
                              pid: m.live.pid,
                              tmuxSession: m.live.tmuxSession,
                              tmuxPaneId: m.live.tmuxPaneId,
                              account: m.live.account,
                          }
                        : null,
                    transcript: m.transcript
                        ? {
                              sessionId: m.transcript.sessionId,
                              hasLeadAssignment: m.transcript.hasLeadAssignment,
                              messageCount: m.transcript.messageCount,
                              lastMessage: m.transcript.lastMessage,
                          }
                        : null,
                    hasPrompt: Boolean(m.member.prompt),
                })),
            }))
        );
        prof.summary("teams --json");
        return;
    }

    if (flags.watch) {
        await runWatch(flags.all);
        return;
    }

    // Need both stdin (keys) and stdout (redraw) TTYs for the table picker.
    if (!isInteractive() || !process.stdout.isTTY) {
        const teams = discoverTeams({ all: flags.all });
        printTeamsList(teams);
        if (teams.length === 0) {
            out.printlnErr(pc.dim(suggestCommand("tools claude teams", { add: ["--all"] })));
        } else if (isInteractive() && !process.stdout.isTTY) {
            out.printlnErr(pc.dim("Interactive attach UI needs a real terminal (stdout is piped)."));
        } else {
            out.printlnErr(pc.dim("Interactive attach UI needs a TTY. Re-run in a terminal, or use --json."));
        }
        prof.summary("teams list");
        return;
    }

    await runTeamsInteractive({ all: flags.all, account: flags.account });
    prof.summary("teams interactive");
}

async function runWatch(all?: boolean): Promise<void> {
    // Piped watch output is a log, not a screen — escape sequences would end up in it.
    const clear = () => {
        if (process.stdout.isTTY) {
            process.stdout.write("\x1b[2J\x1b[H");
        }
    };

    out.printlnErr(pc.dim("watch · every 2s · Ctrl+C to stop"));
    for (;;) {
        try {
            clear();
            const teams = discoverTeams({ all });
            out.println(`${pc.dim(new Date().toLocaleTimeString())}  tools claude teams${all ? " --all" : ""}`);
            out.println("");
            printTeamsList(teams);
        } catch (error) {
            // One bad tick must not end the watch: the usual causes are transient
            // (a team config being rewritten, a transcript truncated mid-scan) and
            // the next tick recovers. Report it and keep the screen alive.
            logger.warn({ error, all }, "[teams] watch tick failed; retrying on the next tick");
            out.printlnErr(pc.red(`watch tick failed: ${error instanceof Error ? error.message : String(error)}`));
        }

        await Bun.sleep(2000);
    }
}
