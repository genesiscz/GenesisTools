#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger, out } from "@genesiscz/utils/logger";
import { handleReadmeFlag } from "@genesiscz/utils/readme";
import { Command } from "commander";
import { ReplEngine } from "./lib/engine";
import { parseToolsetList, REPL_TOOLSET_IDS } from "./lib/toolsets";

handleReadmeFlag(import.meta.url);

/** The `--toolset` list, or undefined after printing the known ids for an empty or unknown entry. */
function toolsetsOption(value: string | boolean | undefined, subcommand: string): string[] | undefined {
    if (value === undefined) {
        return [];
    }

    try {
        if (typeof value !== "string" || value.trim() === "") {
            throw new Error("--toolset needs a value");
        }

        return parseToolsetList(value);
    } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        out.println(
            suggestEnumFlag(toolCommand("node-repl"), "--toolset", REPL_TOOLSET_IDS, {
                subcommand: [subcommand],
                given: typeof value === "string" ? value : undefined,
            })
        );
        process.exitCode = 1;
        return undefined;
    }
}

const program = new Command();
program
    .name("node-repl")
    .description(
        "A persistent JavaScript/TypeScript REPL for agents: bindings survive across calls, top-level await works, images come back as MCP content, and --toolset preloads APIs (computer) once per worker. The same four tools Codex's node_repl exposes, without Codex."
    );

program
    .command("mcp")
    .description("Start the MCP stdio server (tools: js, js_reset, js_add_node_module_dir, turn_ended)")
    .option("--toolset [list]", `comma-separated toolsets to preload: ${REPL_TOOLSET_IDS.join(", ")}`)
    .action(async (opts: { toolset?: string | boolean }) => {
        const toolsets = toolsetsOption(opts.toolset, "mcp");

        if (!toolsets) {
            return;
        }

        const { startMcpServer } = await import("./mcp/server");
        await startMcpServer({ toolsets });
    });

program
    .command("run [code]")
    .description("Run one turn and print its output; reads code from --file or stdin when omitted")
    .option("--file <path>", "read the code from a file")
    .option("--timeout <ms>", "wall-clock budget", "30000")
    .option("--toolset [list]", `comma-separated toolsets to preload: ${REPL_TOOLSET_IDS.join(", ")}`)
    .action(async (code: string | undefined, opts: { file?: string; timeout: string; toolset?: string | boolean }) => {
        // Bun fires a timer scheduled with NaN or a negative delay immediately, so an unchecked
        // --timeout reports "the turn overran" for what is a bad argument.
        const timeout = Number(opts.timeout);

        if (!Number.isFinite(timeout) || timeout <= 0) {
            logger.error(`--timeout must be a positive number of milliseconds, got "${opts.timeout}"`);
            process.exitCode = 1;
            return;
        }

        const toolsets = toolsetsOption(opts.toolset, "run");

        if (!toolsets) {
            return;
        }

        const source = opts.file ? readFileSync(opts.file, "utf8") : (code ?? (await Bun.stdin.text()));
        const engine = new ReplEngine({ toolsets });

        try {
            const result = await engine.run(source, timeout);
            out.print(result.text);

            for (const image of result.images) {
                out.log.info(`image written to ${image.path}`);
            }

            if (!result.ok) {
                logger.error(result.stack ?? result.error ?? "unknown error");
                process.exitCode = 1;
            }
        } finally {
            await engine.shutdown();
        }
    });

await runTool(program, { tool: "node-repl" });
