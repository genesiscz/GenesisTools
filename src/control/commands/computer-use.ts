import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { z } from "zod";
import { ComputerReplEngine } from "../lib/computer-use/repl";
import { ensureBinary } from "../lib/runner";

export function registerComputerUseCommands(program: Command) {
    program
        .command("prepare")
        .description("Compile the native backend before latency-sensitive UI calls")
        .action(() => {
            out.result({ ok: true, binary: ensureBinary() });
        });
    program
        .command("mcp")
        .description("Independent native Computer Use MCP; --repl exposes persistent JS/TS with computer preloaded")
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
        .description("Run JS/TS with the independent computer API preloaded (one process, no Codex or Sky)")
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
