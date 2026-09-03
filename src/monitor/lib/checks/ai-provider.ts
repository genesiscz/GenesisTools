import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { tryProviderPlugin } from "@genesiscz/utils/ai/providers/registry";
import { logger } from "@genesiscz/utils/logger";
import type { AiAccountOption, CheckResult, Watcher } from "../types";

async function loadAccounts(): Promise<AccountEntry[]> {
    const store = await AiConfigStore.load();

    return store.data().accounts;
}

export async function listAiAccountOptions(): Promise<AiAccountOption[]> {
    registerBuiltInPlugins();
    const accounts = await loadAccounts();

    return accounts.map((account) => ({
        id: account.id,
        name: account.name,
        provider: account.provider,
        enabled: account.enabled,
        hasHealth: typeof tryProviderPlugin(account.provider)?.health === "function",
    }));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            const error = new Error(`health probe timed out after ${Math.round(timeoutMs / 1000)} s`);
            error.name = "TimeoutError";
            reject(error);
        }, timeoutMs);

        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

/**
 * Runs the provider plugin's health probe for one configured account. The
 * probe flag makes the plugin read credentials without rotating them, so a
 * watcher polling every minute can never spend a single-use refresh token.
 */
export async function checkAiProvider(watcher: Pick<Watcher, "target" | "config" | "timeoutMs">): Promise<CheckResult> {
    registerBuiltInPlugins();
    const accounts = await loadAccounts();
    const account = accounts.find((entry) => entry.id === watcher.target);

    if (!account) {
        return {
            status: "unknown",
            latencyMs: null,
            httpStatus: null,
            detail: `no AI account with id ${watcher.target}; run: tools ai config account list`,
        };
    }

    const plugin = tryProviderPlugin(account.provider);

    if (!plugin?.health) {
        return {
            status: "unknown",
            latencyMs: null,
            httpStatus: null,
            detail: `provider "${account.provider}" has no health probe`,
        };
    }

    const started = performance.now();

    try {
        const health = await withTimeout(plugin.health({ account, probe: true }), watcher.timeoutMs);
        const latencyMs = Math.round(performance.now() - started);
        const label = `${account.name} (${account.provider})`;

        if (!health.ok) {
            return { status: "down", latencyMs, httpStatus: null, detail: `${label}: ${health.detail}` };
        }

        const threshold = watcher.config.degradedAboveMs;

        if (threshold !== undefined && latencyMs > threshold) {
            return {
                status: "degraded",
                latencyMs,
                httpStatus: null,
                detail: `${label}: ${health.detail} · ${latencyMs} ms (slower than ${threshold} ms)`,
            };
        }

        return { status: "up", latencyMs, httpStatus: null, detail: `${label}: ${health.detail} · ${latencyMs} ms` };
    } catch (error) {
        const latencyMs = Math.round(performance.now() - started);
        logger.debug({ error, account: account.name }, "monitor: ai provider health probe threw");

        return {
            status: "down",
            latencyMs,
            httpStatus: null,
            detail: `${account.name} (${account.provider}): ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
