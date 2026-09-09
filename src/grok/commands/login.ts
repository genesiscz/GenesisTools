import { runLogin } from "@app/ai/lib/accounts/run-login";
import type { Command } from "commander";

/**
 * A door onto the shared account lib with the provider pinned. The default login is
 * xAI's own OIDC flow (browser + PKCE) with the grant stored in the vault, independent of
 * the Grok CLI; `--home` and `--auth-file` run the same flow and write the CLI's auth.json.
 */
export function registerGrokLoginCommand(program: Command): void {
    program
        .command("login [name]")
        .description("Log in to SuperGrok in the browser and store the grant as a grok-sub account")
        .option("--home <dir>", "Write the login into this GROK_HOME's auth.json instead of the vault")
        .option("--auth-file <file>", "Bind an existing auth.json, or write the login into this file")
        .action(async (name: string | undefined, opts: { home?: string; authFile?: string }) => {
            await runLogin({ provider: "grok-sub", name, ...opts, tool: "tools grok login", subcommand: ["login"] });
        });
}
