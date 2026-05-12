#!/usr/bin/env bun

const argv = process.argv.slice(2);

if (argv.length > 0) {
    const { runCli } = await import("./cli");
    await runCli(argv);
} else {
    const { runMcp } = await import("./mcp");
    await runMcp();
}
