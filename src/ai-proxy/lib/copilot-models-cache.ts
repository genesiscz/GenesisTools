import { resolveGithubCopilotDataDir } from "@app/ai-proxy/lib/account-config";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";
import { probeCopilotModels } from "@app/utils/ai/github-copilot/probe-models";
import type { CopilotModelRecord } from "@app/utils/ai/github-copilot/types";

const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
    fetchedAtMs: number;
    models: CopilotModelRecord[];
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CopilotModelRecord[]>>();
const cacheGenerations = new Map<string, number>();

function currentGeneration(key: string): number {
    return cacheGenerations.get(key) ?? 0;
}

function bumpGeneration(key: string): void {
    cacheGenerations.set(key, currentGeneration(key) + 1);
}

function cacheKey(account: AiProxyAccountConfig): string {
    return `${account.name}:${resolveGithubCopilotDataDir(account)}`;
}

export function clearCopilotModelsCache(accountName?: string): void {
    if (!accountName) {
        cache.clear();
        inFlight.clear();
        cacheGenerations.clear();
        return;
    }

    const keys = new Set([...cache.keys(), ...inFlight.keys()]);

    for (const key of keys) {
        if (key.startsWith(`${accountName}:`)) {
            cache.delete(key);
            bumpGeneration(key);
        }
    }
}

export async function resolveCopilotModelRecords(account: AiProxyAccountConfig): Promise<CopilotModelRecord[]> {
    const key = cacheKey(account);
    const cached = cache.get(key);
    const now = Date.now();

    if (cached && now - cached.fetchedAtMs < CACHE_TTL_MS) {
        return cached.models;
    }

    const pending = inFlight.get(key);
    if (pending) {
        return pending;
    }

    const generation = currentGeneration(key);
    const probe = probeCopilotModels({
        dataDir: resolveGithubCopilotDataDir(account),
        apiBaseUrl: account.baseUrl,
    })
        .then((models) => {
            if (currentGeneration(key) !== generation) {
                inFlight.delete(key);
                return [] as CopilotModelRecord[];
            }

            cache.set(key, { fetchedAtMs: Date.now(), models });
            inFlight.delete(key);

            if (models.length === 0) {
                logger.debug({ account: account.name }, "ai-proxy: copilot model probe returned no models");
            } else {
                logger.debug({ account: account.name, count: models.length }, "ai-proxy: copilot models probed");
            }

            return models;
        })
        .catch((err) => {
            inFlight.delete(key);
            if (currentGeneration(key) !== generation) {
                return [] as CopilotModelRecord[];
            }

            logger.warn({ err, account: account.name }, "ai-proxy: copilot model probe failed");
            return [] as CopilotModelRecord[];
        });

    inFlight.set(key, probe);
    return probe;
}
