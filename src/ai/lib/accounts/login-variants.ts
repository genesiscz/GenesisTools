import type { LoginVariants } from "@genesiscz/utils/ai/providers/account-features";
import { pluginsWithAccounts, providerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { runLoginLong } from "./run-login-long";
import { runLoginSecondary } from "./run-login-secondary";

export type LoginVariantKey = keyof LoginVariants;

export interface RunLoginVariantOptions {
    /** Pinned by a provider's own door; resolved from `--provider` otherwise. */
    provider?: string | true;
    name?: string;
    /** Provider switches the command line set, by `LoginFlag.name`. */
    providerFlags?: ReadonlySet<string>;
    tool: string;
    subcommand?: string[];
}

/** What the core does with one login variant a provider can declare. */
export interface LoginVariantVerb {
    /** The command it registers: `login-long`. The key name lets check-tool-commands see the word. */
    commandName: string;
    /** One line for `--help` on the provider-neutral door, and on a door that brings no wording of its own. */
    description: string;
    run(opts: RunLoginVariantOptions): Promise<void>;
}

/**
 * The verb, the wording and the runner behind each key of `LoginVariants`. Keyed by that type, so a
 * variant added there does not compile until it has its row here.
 */
export const LOGIN_VARIANT_VERBS: Record<LoginVariantKey, LoginVariantVerb> = {
    long: {
        commandName: "login-long",
        description: "Attach a long-lived token to an existing account (providers that have one)",
        run: runLoginLong,
    },
    secondary: {
        commandName: "login-secondary",
        description: "Attach a second, isolated grant to an account (providers that have one)",
        run: runLoginSecondary,
    },
};

function isLoginVariantKey(key: string): key is LoginVariantKey {
    return key in LOGIN_VARIANT_VERBS;
}

/** Every variant the core knows, in the order the doors register them. */
export const LOGIN_VARIANT_KEYS: readonly LoginVariantKey[] =
    Object.keys(LOGIN_VARIANT_VERBS).filter(isLoginVariantKey);

/**
 * Whether a door registers this variant: a provider's own door when that provider declares it, the
 * provider-neutral door (no `provider`) when any provider does.
 */
export function declaresLoginVariant(provider: string | undefined, variant: LoginVariantKey): boolean {
    const plugins = provider === undefined ? pluginsWithAccounts() : [providerPlugin(provider)];

    return plugins.some((plugin) => plugin.accounts?.loginVariants[variant] !== undefined);
}
