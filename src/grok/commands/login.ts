import { registerAccountLoginCommand } from "@app/ai/commands/accounts/login";
import type { Command } from "commander";

/**
 * A door onto the shared account lib with the provider pinned. The default login is
 * xAI's own OIDC flow (browser + PKCE) with the grant stored in the vault, independent of
 * the Grok CLI; `--home` and `--auth-file` run the same flow and write the CLI's auth.json.
 *
 * This used to hand-roll the same `runLogin` call with two of its four flags, so
 * `--import-native` was reachable on codex and not here for no reason anyone chose.
 */
export function registerGrokLoginCommand(program: Command): void {
    registerAccountLoginCommand(program, {
        provider: "grok-sub",
        tool: "tools grok login",
        subcommand: ["login"],
        description: "Log in to SuperGrok in the browser and store the grant as a grok-sub account",
    });
}
