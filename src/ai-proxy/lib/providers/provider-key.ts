/** The key a provider is stored and looked up under: `<account>/<provider slug>`. */
export function providerKey(account: { name: string; providerSlug: string }): string {
    return `${account.name}/${account.providerSlug}`;
}

/** A route that names its own provider (`providerKeySuffix`, a session's copy of an account) keeps it apart. */
export function routeProviderKey(route: {
    accountName: string;
    providerSlug: string;
    providerKeySuffix?: string;
}): string {
    return `${providerKey({ name: route.accountName, providerSlug: route.providerSlug })}${route.providerKeySuffix ?? ""}`;
}
