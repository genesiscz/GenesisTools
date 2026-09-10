import { GATEWAY_HEADER, REDACTED } from "./constants.ts";

const HEADER_KEYS = new Set(["authorization", GATEWAY_HEADER.toLowerCase(), "x-api-key", "proxy-authorization"]);

export function redactMcpValue<T>(value: T): T {
    return walk(value, undefined) as T;
}

function walk(value: unknown, key: string | undefined): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => walk(item, key));
    }

    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};

        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = walk(v, k);
        }

        return out;
    }

    if (typeof value === "string" && value.length > 0 && key && HEADER_KEYS.has(key.toLowerCase())) {
        return REDACTED;
    }

    if (typeof value === "string" && value.length > 0 && key && /token|secret|password|api[-_]?key/i.test(key)) {
        return REDACTED;
    }

    return value;
}
