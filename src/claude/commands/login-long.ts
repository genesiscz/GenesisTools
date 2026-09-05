import { runLoginLong } from "@app/ai/lib/accounts/run-login-long";
import type { Command } from "commander";

/**
 * A door onto the shared account lib with the provider pinned. Same command
 * name and same options as before; `tools ai accounts login-long --provider
 * claude` reaches the identical code.
 */
export function registerLoginLongCommand(program: Command): void {
    program
        .command("login-long [name]")
        .description(
            "Attach a long-lived OAuth token to an existing account — minted here via the " +
                "setup-token OAuth flow, or pasted from `claude setup-token`"
        )
        .option("--setup-token", "Skip the prompt and mint the token via the OAuth flow")
        .action(async (name: string | undefined, opts: { setupToken?: boolean }) => {
            await runLoginLong({
                provider: "anthropic-sub",
                name,
                setupToken: opts.setupToken,
                tool: "tools claude login-long",
                subcommand: ["login-long"],
            });
        });
}
