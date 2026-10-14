import { accountEnvVar } from "@genesiscz/utils/ai/account-env";
import type { Command } from "commander";
import { type AgentWhoOptions, runAgentWho } from "../../lib/agent-who";

export type { AgentWhoOptions };

/** `tools <agent> who`: the shared table (src/ai/lib/agent-who.ts) for one agent's {@link AgentWhoOptions}. */
export function registerAgentWhoCommand(program: Command, options: AgentWhoOptions): Command {
    return program
        .command("who")
        .alias("active")
        .description(
            `List live ${options.alias} processes with the account each one runs as ` +
                `(read from ${accountEnvVar(options.alias)} in the process env; ` +
                `'${options.noAccountLabel ?? "native?"}' = launched outside ${options.tool} run), ` +
                "the session each runs and its cmux tab"
        )
        .option("--json", "Machine-readable output")
        .option("--all", "Include helper processes")
        .action(async (flags: { json?: boolean; all?: boolean }) => {
            await runAgentWho(options, flags);
        });
}
