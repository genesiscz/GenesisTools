import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { CatalogOptions } from "@app/ai-proxy/lib/providers/definition";
import { providerDefinition } from "@app/ai-proxy/lib/providers/registry";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import { concurrentMap } from "@genesiscz/utils/async";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { secretGeneration } from "@genesiscz/utils/security/SecretStore";
import { toolDataDir } from "@genesiscz/utils/storage/root";

export { catalogFilePath, loadCatalogFile, type ModelsCatalogFile } from "@app/ai-proxy/lib/catalog-file";

const catalogCache = new Map<string, { expires: number; models: ProxyModelMeta[] }>();
const catalogRequests = new Map<string, Promise<ProxyModelMeta[]>>();
const CATALOG_TTL_MS = 30_000;
const CATALOG_LIMIT = 64;

export function resetProxyCatalogCache(): void {
    catalogCache.clear();
    catalogRequests.clear();
}

function fileGeneration(file: string): string {
    try {
        const stat = statSync(file);
        return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
        if (code === "ENOENT") {
            return `${file}:missing`;
        }
        // An unreadable auth file must not fail the whole catalog: the account's own catalog
        // call reaches the same file and falls back to its static models.
        logger.debug({ file, error }, "ai-proxy: catalog key could not stat a file");
        return `${file}:error:${code}`;
    }
}

function catalogKey(account: AiProxyAccountConfig, options?: CatalogOptions): string {
    const auth = (providerDefinition(account.provider)?.models.cacheFiles(account) ?? []).map(fileGeneration);
    return createHash("sha256")
        .update(
            SafeJSON.stringify([
                account,
                options?.probe === true,
                fileGeneration(toolDataDir("ai", "config.json")),
                secretGeneration(),
                auth,
            ])
        )
        .digest("hex");
}

async function cachedCatalog(account: AiProxyAccountConfig, options?: CatalogOptions): Promise<ProxyModelMeta[]> {
    const key = catalogKey(account, options);
    const cached = catalogCache.get(key);
    if (!options?.fresh && cached && cached.expires > Date.now()) {
        return structuredClone(cached.models);
    }
    let request = catalogRequests.get(key);
    if (!request) {
        request = accountCatalog(account, options)
            .then((models) => {
                catalogCache.delete(key);
                catalogCache.set(key, { models, expires: Date.now() + CATALOG_TTL_MS });
                while (catalogCache.size > CATALOG_LIMIT) {
                    const oldest = catalogCache.keys().next().value;
                    if (oldest !== undefined) {
                        catalogCache.delete(oldest);
                    }
                }
                return models;
            })
            .finally(() => {
                if (catalogRequests.get(key) === request) {
                    catalogRequests.delete(key);
                }
            });
        catalogRequests.set(key, request);
    }
    return structuredClone(await request);
}

export async function buildProxyModelCatalog(
    accounts: AiProxyAccountConfig[],
    options?: CatalogOptions
): Promise<ProxyModelMeta[]> {
    const enabled = accounts.filter((account) => account.enabled);
    const loaded = await concurrentMap({
        items: enabled,
        concurrency: 3,
        fn: (account) => cachedCatalog(account, options),
        onError: (account, error) => {
            logger.warn({ account: account.name, error }, "ai-proxy: catalog account failed");
            throw error;
        },
    });
    return enabled.flatMap((account) => loaded.get(account) ?? []);
}

/** The account's own provider lists its models; a provider this build does not know lists none. */
async function accountCatalog(account: AiProxyAccountConfig, options?: CatalogOptions): Promise<ProxyModelMeta[]> {
    return (await providerDefinition(account.provider)?.models.list(account, options)) ?? [];
}
