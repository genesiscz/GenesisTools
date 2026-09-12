/**
 * The one list of coding agents this repo drives, as CLI aliases.
 *
 * A leaf module on purpose: `aliases.ts` needs the plugin registry for its error path, and
 * every union below is a type import that must stay free of that dependency. Six unions used
 * to spell these three words separately (`AgentKind`, `WorkerBackend`, `NativeSessionProvider`,
 * `TranscriptProvider`, `SpendScope.source`, `AgentId`); each is now an alias of this type, so
 * adding a fourth agent is one entry here plus every `Record<AccountProviderAlias, …>` table
 * the compiler then refuses to accept without a row.
 */
export const ACCOUNT_PROVIDER_ALIASES = ["claude", "codex", "grok"] as const;

export type AccountProviderAlias = (typeof ACCOUNT_PROVIDER_ALIASES)[number];

export function isAccountProviderAlias(value: string): value is AccountProviderAlias {
    return (ACCOUNT_PROVIDER_ALIASES as readonly string[]).includes(value);
}
