/**
 * PEM files of private certificate authorities that `verifiedTls` trusts on top of the public roots.
 * GenesisTools ships none. A repository that vendors `@genesiscz/utils` replaces this module with its own list.
 */
export function privateCaFiles(): string[] {
    return [];
}
