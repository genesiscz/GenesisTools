import { ACCOUNT_PROVIDER_ALIASES, type AccountProviderAlias } from "./providers/aliases";

/**
 * Which account a LIVE agent process bills, read back off the process table.
 *
 * Nothing durable records it. A Codex rollout's `session_meta` payload and all 39 columns of
 * its `threads` row are account-blind (checked against `~/.codex` on 2026-09-11), a Claude
 * transcript is the same, and the history index has no account column either. The launcher's
 * environment is the only truthful answer to "which account does this pane bill", which is why
 * every launcher exports one of these and every reader comes through here.
 *
 * The name is derived from the provider alias rather than listed, so a fourth provider cannot
 * be half-wired: `TOOLS_CLAUDE_ACCOUNT`, `TOOLS_CODEX_ACCOUNT`, `TOOLS_GROK_ACCOUNT`.
 */
export function accountEnvVar(alias: AccountProviderAlias): string {
    return `TOOLS_${alias.toUpperCase()}_ACCOUNT`;
}

/** Every account variable, for a reader that scans one `ps` line for all providers at once. */
export const ACCOUNT_ENV_VARS: Readonly<Record<AccountProviderAlias, string>> = Object.fromEntries(
    ACCOUNT_PROVIDER_ALIASES.map((alias) => [alias, accountEnvVar(alias)])
) as Record<AccountProviderAlias, string>;

export interface LiveAccount {
    /** The account name, or null when the process was launched outside `tools <tool> run`. */
    account: string | null;
    /** Set INSTEAD of `account` when the launcher pointed the process at the ai-proxy. */
    proxyTarget: string | null;
}

const NONE: LiveAccount = { account: null, proxyTarget: null };

/**
 * Read one provider's account out of a `ps -e` args-plus-environment line.
 *
 * `envArgs` is the whole line, so the variable is matched at a word boundary: a bare
 * `indexOf` would also hit `TOOLS_CLAUDE_ACCOUNT_FILE` or a value that merely contains the
 * name.
 */
export function accountFromEnv(envArgs: string, alias: AccountProviderAlias): LiveAccount {
    const match = envArgs.match(new RegExp(`(?:^|\\s)${accountEnvVar(alias)}=(\\S+)`));

    if (!match) {
        return NONE;
    }

    const value = match[1];

    if (value.startsWith("proxy:")) {
        return { account: null, proxyTarget: value.slice("proxy:".length) };
    }

    return { account: value, proxyTarget: null };
}

/**
 * The first provider account the line carries, with the alias that supplied it.
 *
 * A process only ever carries one: the launchers are separate commands. Scanning all three is
 * what lets one process walk attribute Claude, Codex and Grok panes in the same pass.
 */
export function anyAccountFromEnv(envArgs: string): (LiveAccount & { provider: AccountProviderAlias }) | undefined {
    for (const alias of ACCOUNT_PROVIDER_ALIASES) {
        const found = accountFromEnv(envArgs, alias);

        if (found.account !== null || found.proxyTarget !== null) {
            return { ...found, provider: alias };
        }
    }

    return undefined;
}
