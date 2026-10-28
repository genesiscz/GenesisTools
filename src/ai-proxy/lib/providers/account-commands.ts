import { CODEX_ACCOUNT_COMMANDS } from "@app/ai-proxy/lib/providers/codex/account-commands";
import { OPENROUTER_ACCOUNT_COMMANDS } from "@app/ai-proxy/lib/providers/openrouter/account-commands";
import type { AiProxyProviderType } from "@app/ai-proxy/lib/types";
import type { Command } from "commander";

/** A `tools ai-proxy accounts` subcommand that only one provider's accounts take (`status` for Codex). */
export interface ProviderAccountCommand {
    /** Adds the subcommand to the `accounts` command. */
    register(accounts: Command): void;
}

/**
 * The `accounts` subcommands only one provider's accounts take, per provider type; [] for none. The key type is the
 * union, so a provider with no entry is a compile error, as in `PROVIDER_DEFINITIONS`.
 *
 * It is a table of its own, imported by the CLI entry only: the commands reach the config store and the login stores,
 * and a member of `ProviderDefinition` would load those into every module that imports the registry (the server, the
 * model listings).
 */
export const PROVIDER_ACCOUNT_COMMANDS: Readonly<Record<AiProxyProviderType, readonly ProviderAccountCommand[]>> = {
    "grok-subscription": [],
    "github-copilot-subscription": [],
    "anthropic-subscription": [],
    "openai-subscription": CODEX_ACCOUNT_COMMANDS,
    "xai-api-key": [],
    openai: [],
    openrouter: OPENROUTER_ACCOUNT_COMMANDS,
};
