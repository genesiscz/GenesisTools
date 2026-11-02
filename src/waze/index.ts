#!/usr/bin/env bun
import { runTool } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { handleReadmeFlag } from "@genesiscz/utils/readme";
import { createBoxTable, formatDotStatus } from "@genesiscz/utils/table";
import { Command } from "commander";
import { registerAreaCommands } from "./commands/area";
import { registerHistoryCommands } from "./commands/history";
import { globalOptions, parseIntArg } from "./commands/run";
import { registerTripCommands } from "./commands/trip";
import { type CheckStatus, runDoctor } from "./lib/doctor";

handleReadmeFlag(import.meta.url);

const program = new Command()
    .name("waze")
    .description(
        "Waze from the terminal and as an MCP server: police and every other report along a whole trip, routes, jams, departure times, exports, history and hotspots (through a Waze live-map tab in your Brave)"
    )
    .option("--json", "Print the result as JSON")
    .option("--port <port>", "Browser CDP port (default 9222)", parseIntArg)
    .option("--keep-tab", "Leave the Waze live-map tab open for the next run (faster)");

registerTripCommands(program);
registerAreaCommands(program);
registerHistoryCommands(program);

const STATUS_DOT: Record<CheckStatus, Parameters<typeof formatDotStatus>[0]> = {
    ok: "ok",
    warn: "warn",
    fail: "err",
    skip: "dim",
};

program
    .command("doctor")
    .description("Read-only check: browser port, the live-map tab, one token mint and one georss call")
    .action(async (_flags: unknown, command: Command) => {
        const opts = globalOptions(command);
        const checks = await runDoctor({ port: opts.port });
        if (checks.some((check) => check.status === "fail")) {
            process.exitCode = 1;
        }

        if (opts.json) {
            out.result(checks);
            return;
        }

        const table = createBoxTable(["CHECK", "STATUS", "DETAIL"]);
        for (const check of checks) {
            table.push([check.name, formatDotStatus(STATUS_DOT[check.status], check.status), check.detail]);
        }

        out.println(table.toString());
        for (const check of checks.filter((candidate) => candidate.fix)) {
            out.println(`Fix ${check.name}: ${check.fix}`);
        }
    });

program
    .command("mcp")
    .description("Start the stdio MCP server (every command as a tool)")
    .action(async (_flags: unknown, command: Command) => {
        const opts = globalOptions(command);
        const { startMcpServer } = await import("./mcp/server");
        await startMcpServer({ port: opts.port, keepTab: opts.keepTab });
    });

if (import.meta.main) {
    await runTool(program, { tool: "waze" });
}
