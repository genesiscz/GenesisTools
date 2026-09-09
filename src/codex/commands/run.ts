import type { Command } from "commander";
import { runAccountTerminal } from "../lib/run-account-terminal";
import type { CodexRunOptions } from "../lib/run-options";

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

/** Per-parse, not per-registration: the flag used to survive into the next parseAsync. */
function onceOption(seen: Set<string>, name: string): () => void {
    return () => {
        if (seen.has(name)) {
            throw new Error(`Specify --${name} only once`);
        }
        seen.add(name);
    };
}

export function registerRunCommand(program: Command, options: { positional?: boolean } = {}): void {
    if (options.positional ?? nativeRunInvocation(process.argv.slice(2))) {
        program.enablePositionalOptions();
    }

    const seen = new Set<string>();
    program
        .command("run <account> [codex-args...]")
        .alias("start")
        .description("Run the native Codex terminal with an account-bound app-server (experimental)")
        .option("--cwd <path>", "Working directory")
        .option(
            "--computer-use",
            "Require the official Mac Computer Use runtime (automatically enabled when installed)"
        )
        .option("--no-computer-use", "Skip native Computer Use configuration overrides")
        .option("--home <path>", "Shared Codex home (default ~/.codex, independent of inherited CODEX_HOME)")
        .option("-m, --model <model>", "Model ID or alias (astra, terra, luna, sol)")
        .option("--resume [query]", "Native resume picker, or search this provider's sessions")
        .option("--all", "Search or resume across all projects")
        .allowUnknownOption()
        .on("option:model", onceOption(seen, "model"))
        .on("option:resume", onceOption(seen, "resume"))
        .hook("preAction", () => {
            seen.clear();
        })
        .action(async (selector: string, args: string[], options: CodexRunOptions) => {
            await runAccountTerminal({ selector, args, options });
        });
}
