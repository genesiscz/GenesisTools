import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { ComputerReplEngine } from "../lib/computer-use/repl";
import { ensureBinary } from "../lib/runner";

/**
 * `tools computer-use` is the main door for agents; `tools control` and `tools jev control` register
 * the same three commands as aliases so an existing MCP config keeps working. One core underneath:
 * `ComputerUse` in `lib/computer-use/session.ts`.
 */
export function registerComputerUseCommands(program: Command, options: { primary?: boolean } = {}) {
    const alias = (text: string, name: string) =>
        options.primary ? text : `${text} (alias of \`${toolCommand("computer-use")} ${name}\`)`;
    program
        .command("prepare")
        .description(alias("Compile the native backend before latency-sensitive UI calls", "prepare"))
        .action(() => {
            out.result({ ok: true, binary: ensureBinary() });
        });
    program
        .command("mcp")
        .description(
            alias(
                "Native Computer Use MCP (no Codex or Sky); --repl exposes persistent JS/TS with computer preloaded",
                "mcp"
            )
        )
        .option("--repl", "Use the four node-repl-compatible tools with the native computer API")
        .action(async (options: { repl?: boolean }) => {
            if (options.repl) {
                await (await import("../lib/computer-use/repl")).startComputerReplServer();
            } else {
                await (await import("../mcp/server")).startComputerMcpServer();
            }
        });
    program
        .command("computer-run [code]")
        .description(
            alias(
                "Run JS/TS with the computer API preloaded (one process, no Codex or Sky). The turn is an async module body: the LAST EXPRESSION is the result, top-level `await` works, and a top-level `return` is a syntax error. Emit extra output with `nodeRepl.write(value)`; console.log is captured into the same text.",
                "run"
            )
        )
        .option("--file <path>", "Read script from a file")
        .option("--timeout <ms>", "Whole REPL turn deadline", "30000")
        .option("--json", "Return structured REPL result")
        .action(async (code: string | undefined, options: { file?: string; timeout: string; json?: boolean }) => {
            const timeout = z.number().int().min(1).max(300000).parse(Number(options.timeout));
            const source = options.file ? await Bun.file(options.file).text() : (code ?? (await Bun.stdin.text()));
            const engine = new ComputerReplEngine({ defaultTimeoutMs: timeout });
            try {
                const result = await engine.run(source, timeout);
                if (options.json) {
                    out.result(result);
                } else {
                    out.print(result.text);
                    if (!result.ok) {
                        logger.error(result.stack ?? result.error ?? "Computer Use script failed.");
                    }
                    for (const image of result.images) {
                        out.print(SafeJSON.stringify({ image: image.path, mimeType: image.mimeType }));
                    }
                }
                if (!result.ok) {
                    process.exitCode = 1;
                }
            } finally {
                engine.dispose();
            }
        });
}
