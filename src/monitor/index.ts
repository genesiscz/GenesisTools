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
  tools monitor                                   interactive menu (terminal only)
  tools monitor add https://example.com --degraded-ms 1500
  tools monitor add --preset claude-api status.claude.com
  tools monitor add status.x.ai/feed.xml --kind rss --item-filter outage
  tools monitor add db.local:5432 --kind tcp --name "Postgres"
  tools monitor add example.com --kind tls --warn-days 30
  tools monitor add https://api.example.com/health --kind json --json-path status --expect ok
  tools monitor add "pg_isready -h db.local" --kind command
  tools monitor targets add --channel webhook --name "Slack ops" --url https://hooks.slack.com/…
  tools monitor edit 3 --targets 1,2 --interval 300
  tools monitor mute 3 --for 2h
  tools monitor check          probe everything, record nothing (exit 2 when something is down)
  tools monitor run            record, open incidents, notify
  tools monitor status | uptime | incidents --open | show 3 | history 3 --since 1d
  tools monitor export -o monitor.json && tools monitor import monitor.json
  tools monitor watch          live events from the server
  tools monitor doctor         read-only health report
  tools monitor server up && tools monitor ui up
Every command takes --json for machine-readable output.`
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

const program = buildMonitorProgram();

await runTool(program, { tool: "monitor" }).catch((error) => {
    if (error instanceof WatcherValidationError) {
        out.error(error.message);
    } else {
        out.error(error instanceof Error ? error.message : String(error));
    }

    process.exitCode = 1;
});
