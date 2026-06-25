/** Low-level env reads — only envVariables.ts and env.testing should use process.env directly. */

export type EnvKey = string;

export function getRaw(name: EnvKey): string | undefined {
    return process.env[name];
}

export function getTrimmed(name: EnvKey): string | undefined {
    const raw = getRaw(name);
    if (raw === undefined) {
        return undefined;
    }

    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function has(name: EnvKey): boolean {
    return getRaw(name) !== undefined;
}

export function isNonEmpty(name: EnvKey): boolean {
    return getTrimmed(name) !== undefined;
}

/** Common gate for DEBUG, E2E, RUN_NETWORK_TESTS, flags set to "1", etc. */
export function isFlag(name: EnvKey, truthy = "1"): boolean {
    return getRaw(name) === truthy;
}

export function getFirst(keys: readonly EnvKey[]): { key: EnvKey; value: string } | undefined {
    for (const key of keys) {
        const value = getTrimmed(key);
        if (value !== undefined) {
            return { key, value };
        }
    }

    return undefined;
}

export function getFirstValue(keys: readonly EnvKey[]): string | undefined {
    return getFirst(keys)?.value;
}

export function getFirstEnvKey(keys: readonly EnvKey[]): EnvKey | undefined {
    return getFirst(keys)?.key;
}

export function getWithDefault(name: EnvKey, fallback: string): string {
    return getTrimmed(name) ?? fallback;
}

export function parseIntEnv(name: EnvKey, fallback: number): number {
    const raw = getTrimmed(name);
    if (!raw) {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export interface ApiKeyAccessor {
    getKey(): string | undefined;
    getEnvKey(): EnvKey | undefined;
    hasKey(): boolean;
}

export function createApiKeyAccessor(keys: readonly EnvKey[]): ApiKeyAccessor {
    return {
        getKey: () => getFirstValue(keys),
        getEnvKey: () => getFirstEnvKey(keys),
        hasKey: () => getFirstValue(keys) !== undefined,
    };
}
