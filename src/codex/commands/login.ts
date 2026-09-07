import { runLogin } from "@app/ai/lib/accounts/run-login";
import type { Command } from "commander";

/**
 * A door onto the shared account lib with the provider pinned. The login writes
 * the codex home's `auth.json` in the shape the official CLI reads, so the CLI,
 * the ChatGPT app and GenesisTools share one token per profile.
 */
export function registerCodexLoginCommand(program: Command): void {
    program
        .command("login [name]")
        .description("Browser login for the ChatGPT/Codex subscription, written to the codex home's auth.json")
        .option("--home <dir>", "Codex profile directory to log into (default ~/.codex)")
        .option("--auth-file <file>", "Bind an existing auth.json instead of running the browser flow")
        .action(async (name: string | undefined, opts: { home?: string; authFile?: string }) => {
            await runLogin({ provider: "openai-sub", name, ...opts, tool: "tools codex login", subcommand: ["login"] });
        });
}
