import { registerAgentRunCommand } from "@app/ai/commands/agent/run";
import type { Command } from "commander";
import { codexSpec } from "../lib/spec";

/**
 * True when argv actually invokes `codex run|start`.
 *
 * Positional option parsing is what lets `run <account> …` forward native flags verbatim, but
 * commander applies it to the whole program: with it on, the global `-v` is no longer recognised
 * after ANY subcommand name, so `tools codex sessions -v` started failing with
 * `unknown option '-v'`. Scope it to the one invocation that needs it.
 */
export function nativeRunInvocation(argv: string[]): boolean {
    const verb = argv.find((entry) => !entry.startsWith("-"));

    return verb === "run" || verb === "start";
}

/** The shared `run` with the Codex launcher, behind the positional-options gate above. */
export function registerRunCommand(program: Command, options: { positional?: boolean } = {}): void {
    if (options.positional ?? nativeRunInvocation(process.argv.slice(2))) {
        program.enablePositionalOptions();
    }

    registerAgentRunCommand(program, codexSpec);
}
