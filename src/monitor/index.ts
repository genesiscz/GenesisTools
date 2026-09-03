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
        .description("Uptime watchers for websites, status pages and AI providers: CLI + daemon + dashboard")
        .version(MONITOR_VERSION);

    registerWatcherCommands(program);
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
