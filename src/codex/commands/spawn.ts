import { readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { parseWritePolicy, schemaDriftWarning, spawnCodexSession } from "../lib/spawn";
import type { CodexWritePolicy } from "../lib/store";

const log = logger.child({ component: "codex:spawn" });

interface SpawnCliOptions {
    name: string;
    cwd?: string;
    home?: string;
    model?: string;
    effort?: string;
    write?: CodexWritePolicy;
    mode?: "review" | "task";
    prompt?: string;
    promptFile?: string;
    agents?: boolean;
    session?: string;
    writableRoot?: string[];
}

export function registerSpawnCommand(program: Command): void {
    program
        .command("spawn")
        .description("Spawn a long-lived Codex app-server session")
        .requiredOption("--name <name>", "Unique session name")
        .option("--cwd <path>", "Working directory")
        .option("--home <path>", "CODEX_HOME override")
        .option("--model <model>", "Codex model")
        .option("--effort <effort>", "Reasoning effort")
        .option("--write <policy>", "ask | allow | deny")
        .option("--mode <mode>", "review | task", "task")
        .option("--prompt <text>", "Start the first turn with this prompt")
        .option("--prompt-file <path>", "Read the first prompt from a file")
        .option("--no-agents", "Disable tools agents integration")
        .option("--session <id>", "Parent tools agents session id")
        .option("--writable-root <path...>", "Additional writable roots")
        .action(async (options: SpawnCliOptions) => {
            if (options.prompt && options.promptFile) {
                throw new Error("--prompt and --prompt-file are mutually exclusive");
            }

            if (options.mode !== "review" && options.mode !== "task") {
                throw new Error("--mode must be review or task");
            }

            const prompt = options.promptFile ? readFileSync(options.promptFile, "utf8") : options.prompt;
            const meta = await spawnCodexSession({
                ...options,
                prompt,
                write: parseWritePolicy(options.write),
                rendezvousSession: options.session,
                writableRoots: options.writableRoot,
            });
            const warning = schemaDriftWarning(meta.codexVersion);
            if (warning) {
                log.warn({ installed: meta.codexVersion }, warning);
                out.log.warn(warning);
            }

            out.result(SafeJSON.stringify(meta, null, 2));
        });
}
