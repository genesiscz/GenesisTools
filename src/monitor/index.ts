import { registerExtraCommands } from "@app/monitor/commands/extras";
import { runInteractiveMenu } from "@app/monitor/commands/interactive";
import { registerNotifyCommands } from "@app/monitor/commands/notify";
import { registerTargetCommands } from "@app/monitor/commands/targets";
import { registerUiCommand } from "@app/monitor/commands/ui";
import { registerWatcherCommands } from "@app/monitor/commands/watchers";
import { monitorServerApp } from "@app/monitor/lib/server/app";
import { MONITOR_VERSION } from "@app/monitor/lib/types";
import { WatcherValidationError } from "@app/monitor/lib/validate";
import { runTool } from "@genesiscz/utils/cli";
import { enhanceHelp } from "@genesiscz/utils/cli/executor";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";

export function buildMonitorProgram(): Command {
    const program = new Command()
        .name("monitor")
        .description(
            "Watchers for websites, status pages, RSS feeds, TCP ports, DNS, TLS certificates, JSON APIs, shell commands and AI providers: CLI + daemon + dashboard"
        )
        .version(MONITOR_VERSION)
        .addHelpText(
            "after",
            `
Examples:
  ${toolCommand("monitor")}                                   interactive menu (terminal only)
  ${toolCommand("monitor add")} https://example.com --degraded-ms 1500
  ${toolCommand("monitor add")} --preset claude-api status.claude.com
  ${toolCommand("monitor add")} status.x.ai/feed.xml --kind rss --item-filter outage
  ${toolCommand("monitor add")} db.local:5432 --kind tcp --name "Postgres"
  ${toolCommand("monitor add")} example.com --kind tls --warn-days 30
  ${toolCommand("monitor add")} https://api.example.com/health --kind json --json-path status --expect ok
  ${toolCommand("monitor add")} "pg_isready -h db.local" --kind command
  ${toolCommand("monitor targets add")} --channel webhook --name "Slack ops" --url https://hooks.slack.com/…
  ${toolCommand("monitor edit")} 3 --targets 1,2 --interval 300
  ${toolCommand("monitor mute")} 3 --for 2h
  ${toolCommand("monitor check")}          probe everything, record nothing (exit 2 when something is down)
  ${toolCommand("monitor run")}            record, open incidents, notify
  ${toolCommand("monitor status")} | uptime | incidents --open | show 3 | history 3 --since 1d
  ${toolCommand("monitor export")} -o monitor.json && ${toolCommand("monitor import")} monitor.json
  ${toolCommand("monitor watch")}          live events from the server
  ${toolCommand("monitor doctor")}         read-only health report
  ${toolCommand("monitor server up")} && ${toolCommand("monitor ui up")}
Reading commands take --json: list, show, status, uptime, history, check, run, items, incidents, presets, doctor.`
        )
        .action(async () => {
            await runInteractiveMenu();
        });

    registerWatcherCommands(program);
    registerExtraCommands(program);
    registerTargetCommands(program);
    registerNotifyCommands(program);
    program.addCommand(monitorServerApp.commanderCommand);
    registerUiCommand(program);
    enhanceHelp(program);

    return program;
}

// Only run the CLI when executed directly, never on import: a test that pulls
// a helper out of this module would otherwise launch the whole program while
// bun is still collecting the suite.
if (import.meta.main) {
    await runTool(buildMonitorProgram(), { tool: "monitor" }).catch((error) => {
        if (error instanceof WatcherValidationError) {
            out.error(error.message);
        } else {
            out.error(error instanceof Error ? error.message : String(error));
        }

        process.exitCode = 1;
    });
}
