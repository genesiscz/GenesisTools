import { registerLoginVariantCommand } from "@app/ai/commands/accounts/login";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { Command } from "commander";

/**
 * A door onto the shared account lib with the provider pinned. Same command
 * name and same options as before; `tools ai accounts login-long --provider
 * claude` reaches the identical code, and the options come from the plugin.
 */
export function registerLoginLongCommand(program: Command): void {
    registerLoginVariantCommand(program, {
        variant: "long",
        provider: "anthropic-sub",
        tool: toolCommand("claude login-long"),
        subcommand: ["login-long"],
        description:
            "Attach a long-lived OAuth token to an existing account — minted here via the " +
            "setup-token OAuth flow, or pasted from `claude setup-token`",
    });
}
