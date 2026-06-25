import type { EnvKey } from "@app/utils/env/env-core";

export type EnvSnapshot = Record<EnvKey, string | undefined>;

export function snapshotEnv(): EnvSnapshot {
    return { ...process.env };
}

export function restoreEnv(snapshot: EnvSnapshot): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) {
            delete process.env[key];
        }
    }

    for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

export function setEnv(name: EnvKey, value: string): void {
    process.env[name] = value;
}

export function unsetEnv(name: EnvKey): void {
    delete process.env[name];
}

export async function withEnvOverrides(
    overrides: Record<EnvKey, string | undefined>,
    fn: () => void | Promise<void>
): Promise<void> {
    const snapshot = snapshotEnv();

    try {
        for (const [key, value] of Object.entries(overrides)) {
            if (value === undefined) {
                unsetEnv(key);
            } else {
                setEnv(key, value);
            }
        }

        await fn();
    } finally {
        restoreEnv(snapshot);
    }
}
