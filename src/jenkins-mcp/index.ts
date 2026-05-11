#!/usr/bin/env bun

const CLI_COMMANDS = new Set([
    "monitor",
    "log",
    "stages",
    "info",
    "changes",
    "jobs",
    "help",
    "--help",
    "-h",
]);

const sub = process.argv[2];

if (sub && CLI_COMMANDS.has(sub)) {
    const { runCli } = await import("./cli");
    await runCli(process.argv.slice(2));
} else {
    const { runMcp } = await import("./mcp");
    await runMcp();
}
