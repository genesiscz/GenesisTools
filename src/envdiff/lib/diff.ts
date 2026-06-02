import type { ParsedEnv } from "./parse";

export interface MissingKey {
    key: string;
    exampleValue: string;
}

export interface ExtraKey {
    key: string;
}

export interface ChangedKey {
    key: string;
    actualValue: string;
    exampleValue: string;
}

export interface EnvDiff {
    missing: MissingKey[];
    extra: ExtraKey[];
    changed: ChangedKey[];
    inSyncCount: number;
}

export function diffEnv(actual: ParsedEnv, example: ParsedEnv): EnvDiff {
    const missing: MissingKey[] = [];
    const changed: ChangedKey[] = [];
    let inSyncCount = 0;

    for (const key of example.keys) {
        const exampleValue = example.map.get(key) ?? "";
        if (!actual.map.has(key)) {
            missing.push({ key, exampleValue });
            continue;
        }

        const actualValue = actual.map.get(key) ?? "";
        if (actualValue === exampleValue) {
            inSyncCount += 1;
        } else {
            changed.push({ key, actualValue, exampleValue });
        }
    }

    const extra: ExtraKey[] = [];
    for (const key of actual.keys) {
        if (!example.map.has(key)) {
            extra.push({ key });
        }
    }

    return { missing, extra, changed, inSyncCount };
}

export function driftCount(diff: EnvDiff): number {
    return diff.missing.length + diff.extra.length + diff.changed.length;
}

export function hasDrift(diff: EnvDiff): boolean {
    return driftCount(diff) > 0;
}
