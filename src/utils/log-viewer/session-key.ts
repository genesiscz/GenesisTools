import type { LogSourceId } from "./log-source";

export function sessionKey(source: LogSourceId, name: string): string {
    return `${source}:${name}`;
}

export function parseSessionKey(key: string): { source: LogSourceId; name: string } | null {
    const idx = key.indexOf(":");
    if (idx <= 0) {
        return null;
    }

    const source = key.slice(0, idx);
    const name = key.slice(idx + 1);

    if (source !== "debugging-master" && source !== "task") {
        return null;
    }

    if (!name) {
        return null;
    }

    return { source, name };
}

export const LOG_SOURCE_IDS: LogSourceId[] = ["debugging-master", "task"];

export function isLogSourceId(value: string): value is LogSourceId {
    return LOG_SOURCE_IDS.includes(value as LogSourceId);
}
