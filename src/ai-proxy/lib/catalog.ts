import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolveGithubCopilotDataDir, resolveGrokAuthPath } from "@app/ai-proxy/lib/account-config";
import {
    type CatalogOptions,
    listAnthropicSubProxyModels,
    listCopilotProxyModels,
    listGrokProxyModels,
    listOpenAiProxyModels,
    listOpenAiSubProxyModels,
    listOpenRouterProxyModels,
    listXaiProxyModels,
} from "@app/ai-proxy/lib/model-meta";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import { githubTokenPath } from "@genesiscz/utils/ai/github-copilot/paths";
import { GROK_CLI_CHAT_PROXY_BASE_URL } from "@genesiscz/utils/ai/grok";
import { CODEX_AUTH_PATH } from "@genesiscz/utils/ai/openai/codex-auth";
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
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
        }
        return `${file}:missing`;
    }
}

function catalogKey(account: AiProxyAccountConfig, options?: CatalogOptions): string {
    const auth =
        account.provider === "openai-subscription"
            ? fileGeneration(account.openaiSub?.codexAuthPath ?? CODEX_AUTH_PATH)
            : account.provider === "grok-subscription"
              ? fileGeneration(resolveGrokAuthPath(account))
              : account.provider === "github-copilot-subscription"
                ? fileGeneration(githubTokenPath(resolveGithubCopilotDataDir(account)))
                : "";
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
                catalogRequests.delete(key);
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

async function accountCatalog(account: AiProxyAccountConfig, options?: CatalogOptions): Promise<ProxyModelMeta[]> {
    const models: ProxyModelMeta[] = [];
    if (account.provider === "grok-subscription") {
        const baseUrl = account.baseUrl ?? GROK_CLI_CHAT_PROXY_BASE_URL;
        models.push(...listGrokProxyModels(account, baseUrl));
    }

    if (account.provider === "github-copilot-subscription") {
        models.push(...(await listCopilotProxyModels(account)));
    }

    if (account.provider === "anthropic-subscription") {
        models.push(...(await listAnthropicSubProxyModels(account, options)));
    }

    if (account.provider === "openai-subscription") {
        models.push(...(await listOpenAiSubProxyModels(account, options)));
    }

    if (account.provider === "xai-api-key") {
        models.push(...(await listXaiProxyModels(account)));
    }

    if (account.provider === "openrouter") {
        models.push(...(await listOpenRouterProxyModels(account)));
    }

    if (account.provider === "openai") {
        models.push(...(await listOpenAiProxyModels(account)));
    }
    return models;
}
