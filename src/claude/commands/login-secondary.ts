import { runLoginSecondary } from "@app/ai/lib/accounts/run-login-secondary";
import type { Command } from "commander";

/** A door onto the shared account lib with the provider pinned. */
export function registerLoginSecondaryCommand(program: Command): void {
    program
        .command("login-secondary [name]")
        .description(
            "OAuth login stored as a SECONDARY token set on an account — a separate grant used by " +
                "`tools claude start <name> --keychain`, never by usage polling"
        )
        .action(async (name?: string) => {
            await runLoginSecondary({
                provider: "anthropic-sub",
                name,
                tool: "tools claude login-secondary",
                subcommand: ["login-secondary"],
            });
        });
}
