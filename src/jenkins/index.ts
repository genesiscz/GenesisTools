#!/usr/bin/env bun
import { runTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { isJenkinsTarget, runSmartUrlMode } from "./commands/analyze";
import { registerAuth } from "./commands/auth";
import { registerCompare } from "./commands/compare";
import { registerExecutors } from "./commands/executors";
import { registerExtraCommands } from "./commands/extra";
import { registerLogs } from "./commands/logs";
import { registerMcp } from "./commands/mcp";
import { registerMonitor } from "./commands/monitor";
import { registerPing } from "./commands/ping";
import { registerPods } from "./commands/pods";
import { registerRebuild } from "./commands/rebuild";
import { registerSearchLogs } from "./commands/search-logs";
import { registerStages } from "./commands/stages";
import { registerStopRange } from "./commands/stop-range";
import { registerTrack } from "./commands/track";
import { registerTriggers } from "./commands/triggers";
import { applyTlsAcceptFlag, TLS_ACCEPT_FLAG } from "./lib/mcp/client";
import { API_LOG } from "./lib/rest/client";

export function buildJenkinsCommand(): Command {
    const jenkins = new Command("jenkins")
        .description(
            "Jenkins: build stages, logs, monitoring, rebuilds and queue diagnosis over REST, plus the MCP server"
        )
        .argument("[url]", "Jenkins build URL or job path to analyze (smart mode)")
        .addHelpText(
            "after",
            `
First time: ${toolCommand("jenkins login")}   (stores an API token; status / logout too)

TLS: the server is verified against the public roots plus src/jenkins/lib/mcp/*.pem.
     ${TLS_ACCEPT_FLAG} (anywhere on the line) skips verification as a last resort.

Audit log: ${API_LOG}

<url> can be a full Jenkins URL or a job path like job/<folder>/job/<job>`
        )
        .action(async (url: string | undefined) => {
            if (!url) {
                jenkins.help();
                return;
            }

            if (!isJenkinsTarget(url)) {
                throw new Error(
                    `"${url}" is neither a command nor a Jenkins URL. Commands: ${toolCommand("jenkins --help")}`
                );
            }

            await runSmartUrlMode(url);
        });

    registerStages(jenkins);
    registerCompare(jenkins);
    registerMonitor(jenkins);
    registerLogs(jenkins);
    registerSearchLogs(jenkins);
    registerTriggers(jenkins);
    registerStopRange(jenkins);
    registerRebuild(jenkins);
    registerTrack(jenkins);
    registerPods(jenkins);
    registerExecutors(jenkins);
    registerPing(jenkins);
    registerAuth(jenkins);
    registerMcp(jenkins);
    registerExtraCommands(jenkins);

    return jenkins;
}

if (import.meta.main) {
    try {
        await runTool(buildJenkinsCommand(), { tool: "jenkins" }, applyTlsAcceptFlag(process.argv));
    } catch (error) {
        out.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
