import { type LogoutFlags, logoutTargetsFromFlags } from "@app/ai/lib/accounts/logout-flags";
import { runLogout } from "@app/ai/lib/accounts/run-logout";
import type { Command } from "commander";

/**
 * A door onto the shared account lib with the provider pinned. The flags are the
 * ones this command has always taken, `--both` included.
 */
export function registerLogoutCommand(program: Command): void {
    program
        .command("logout [name]")
        .description("Remove saved tokens from an account (OAuth pair, long-lived token, or both)")
        .option("--oauth", "Remove the access + refresh token (stops usage polling)")
        .option("--long-lived", "Remove the long-lived token (used by start/run)")
        .option("--secondary", "Remove the secondary grant (used by start --keychain)")
        .option("--both", "Remove the OAuth pair and the long-lived token")
        .option("--all", "Remove every credential")
        .option("-y, --yes", "Skip the confirmation prompt")
        .action(async (name: string | undefined, opts: LogoutFlags & { yes?: boolean }) => {
            await runLogout({
                provider: "anthropic-sub",
                name,
                targets: logoutTargetsFromFlags(opts),
                yes: opts.yes,
                tool: "tools claude logout",
                subcommand: ["logout"],
            });
        });
}
