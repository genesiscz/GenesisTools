import { registerLoginVariantCommand } from "@app/ai/commands/accounts/login";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { Command } from "commander";

/** A door onto the shared account lib with the provider pinned. */
export function registerLoginSecondaryCommand(program: Command): void {
    registerLoginVariantCommand(program, {
        variant: "secondary",
        provider: "anthropic-sub",
        tool: toolCommand("claude login-secondary"),
        subcommand: ["login-secondary"],
        description:
            "OAuth login stored as a SECONDARY token set on an account — a separate grant used by " +
            `\`${toolCommand("claude start", "<name>", "--keychain")}\`, never by usage polling`,
    });
}
