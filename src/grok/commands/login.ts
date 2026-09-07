import { runLogin } from "@app/ai/lib/accounts/run-login";
import type { Command } from "commander";

/**
 * A door onto the shared account lib with the provider pinned. xAI has no
 * in-process flow, so this prints (and offers to run) `grok login` and then
 * binds the `auth.json` that command writes.
 */
export function registerGrokLoginCommand(program: Command): void {
    program
        .command("login [name]")
        .description("Bind a Grok CLI login as a grok-sub account (runs `grok login` when the file is missing)")
        .option("--home <dir>", "GROK_HOME to log into (default ~/.grok)")
        .option("--auth-file <file>", "Bind an existing auth.json instead of running the CLI")
        .action(async (name: string | undefined, opts: { home?: string; authFile?: string }) => {
            await runLogin({ provider: "grok-sub", name, ...opts, tool: "tools grok login", subcommand: ["login"] });
        });
}
