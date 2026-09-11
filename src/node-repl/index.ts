#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { runTool } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { handleReadmeFlag } from "@genesiscz/utils/readme";
import { Command } from "commander";
import { ReplEngine } from "./lib/engine";

handleReadmeFlag(import.meta.url);

const program = new Command();
program
    .name("node-repl")
    .description(
        "A persistent JavaScript/TypeScript REPL for agents: bindings survive across calls, top-level await works, images come back as MCP content. The same four tools Codex's node_repl exposes, without Codex."
    );

program
    .command("mcp")
    .description("Start the MCP stdio server (tools: js, js_reset, js_add_node_module_dir, turn_ended)")
    .action(async () => {
        const { startMcpServer } = await import("./mcp/server");
        await startMcpServer();
    });

program
    .command("run [code]")
    .description("Run one turn and print its output; reads code from --file or stdin when omitted")
    .option("--file <path>", "read the code from a file")
    .option("--timeout <ms>", "wall-clock budget", "30000")
    .action(async (code: string | undefined, opts: { file?: string; timeout: string }) => {
        const source = opts.file ? readFileSync(opts.file, "utf8") : (code ?? (await Bun.stdin.text()));
        const engine = new ReplEngine();

        try {
            const result = await engine.run(source, Number(opts.timeout));
            out.print(result.text);

            if (!result.ok) {
                logger.error(result.stack ?? result.error ?? "unknown error");
                process.exitCode = 1;
            }
        } finally {
            engine.dispose();
        }
    });

await runTool(program, { tool: "node-repl" });
