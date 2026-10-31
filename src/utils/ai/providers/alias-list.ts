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

/**
 * A table with one entry per harness, each read from its driver. For an old `Record<HarnessId, T>` export whose
 * callers index it by name: the table stays, its values come from the drivers, and the mapped type still refuses a
 * harness without an entry. Here, in the leaf module, so a caller that must stay light (a hook) can build one.
 */
export function byHarness<T>(pick: (id: AccountProviderAlias) => T): Readonly<Record<AccountProviderAlias, T>> {
    return { claude: pick("claude"), codex: pick("codex"), grok: pick("grok") };
}

/**
 * A value for every harness: the type of a table `byHarness` builds, or a stored shape keyed by harness. A mapped type
 * over the alias list, so a file that uses it names no harness and a new harness edits nothing there.
 */
export type PerHarness<T> = Record<AccountProviderAlias, T>;

/** A value for some harnesses: a stored override map or a table `byHarnessWhere` builds. */
export type SomeHarnesses<T> = Partial<Record<AccountProviderAlias, T>>;

/** A table with an entry only for the harnesses `pick` answers for (undefined leaves the harness out). */
export function byHarnessWhere<T>(
    pick: (id: AccountProviderAlias) => T | undefined
): Partial<Record<AccountProviderAlias, T>> {
    const table: Partial<Record<AccountProviderAlias, T>> = {};

    for (const id of ACCOUNT_PROVIDER_ALIASES) {
        const value = pick(id);

        if (value !== undefined) {
            table[id] = value;
        }
    }

    return table;
}
