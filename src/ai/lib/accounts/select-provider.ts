import * as p from "@clack/prompts";
import { ACCOUNT_PROVIDER_ALIASES, providerAliasOf, resolveProviderAlias } from "@genesiscz/utils/ai/providers/aliases";
import type { ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { pluginsWithAccounts, providerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { suggestEnumFlag } from "@genesiscz/utils/cli";

/**
 * `--provider` is an ENUMERATED flag, so it is declared `--provider [value]` and
 * resolved here. Declared as `<value>`, commander exits with a generic "argument
 * missing" that never names `claude`, `codex` or `grok`.
 */

export type ProviderResolution =
    | { status: "ok"; plugin: ProviderPlugin }
    | { status: "help"; help: string }
    | { status: "cancelled" };

export interface ResolveProviderInput {
    /** Raw `--provider`. `true` or `""` means the flag was passed with no value. */
    raw?: string | true;
    interactive: boolean;
    /** Command name for the `suggestCommand` line, e.g. `tools ai accounts`. */
    tool: string;
    subcommand?: string[];
}

function missingEnum(input: ResolveProviderInput, given?: string): ProviderResolution {
    return {
        status: "help",
        help: suggestEnumFlag(input.tool, "--provider", ACCOUNT_PROVIDER_ALIASES, {
            subcommand: input.subcommand,
            given,
        }),
    };
}

export async function resolveAccountsProvider(input: ResolveProviderInput): Promise<ProviderResolution> {
    const raw = input.raw === true ? "" : (input.raw ?? "");

    if (raw.trim() === "") {
        if (!input.interactive) {
            return missingEnum(input);
        }

        const picked = await p.select({
            message: "Which provider?",
            options: pluginsWithAccounts().map((plugin) => ({
                value: plugin.id,
                label: plugin.accounts?.presentation.displayName ?? plugin.id,
                hint: providerAliasOf(plugin.id),
            })),
        });

        if (p.isCancel(picked)) {
            return { status: "cancelled" };
        }

        return { status: "ok", plugin: providerPlugin(picked as string) };
    }

    let id: string;
    try {
        id = resolveProviderAlias(raw);
    } catch {
        return missingEnum(input, raw);
    }

    const plugin = providerPlugin(id);

    // A plugin id that resolves but carries no account features would otherwise
    // fail later with "cannot read properties of undefined".
    if (!plugin.accounts) {
        return missingEnum(input, raw);
    }

    return { status: "ok", plugin };
}
