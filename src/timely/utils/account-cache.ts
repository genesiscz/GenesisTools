export function timelyAccountCacheKey(accountId: number, relativePath: string): string {
    return `accounts/${accountId}/${relativePath.replace(/^\/+/, "")}`;
}
