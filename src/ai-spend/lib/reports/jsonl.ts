import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isRecord, num } from "../drivers/parse-helpers";

export function parseJsonValue(text: string): unknown | undefined {
    try {
        return SafeJSON.parse(text, { strict: true });
    } catch (err) {
        logger.debug({ err }, "ai-spend: skipping malformed JSON");
        return undefined;
    }
}

export function parseJsonl(content: string): unknown[] {
    const rows: unknown[] = [];

    for (const line of content.split("\n")) {
        const trimmed = line.trim();

        if (!trimmed) {
            continue;
        }

        const value = parseJsonValue(trimmed);

        if (value !== undefined) {
            rows.push(value);
        }
    }

    return rows;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number {
    if (typeof value === "number") {
        return num(value);
    }

    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
}

export function pickNumber(record: Record<string, unknown> | undefined, keys: string[]): number {
    if (!record) {
        return 0;
    }

    for (const key of keys) {
        if (key in record) {
            const value = asNumber(record[key]);

            if (value !== 0 || record[key] === 0) {
                return asNumber(record[key]);
            }
        }
    }

    return 0;
}

export function isoFromUnknown(value: unknown): string {
    if (typeof value === "string" && value.length > 0) {
        const date = new Date(value);

        if (!Number.isNaN(date.getTime())) {
            return date.toISOString();
        }

        return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : value;
        const date = new Date(ms);

        if (!Number.isNaN(date.getTime())) {
            return date.toISOString();
        }
    }

    return "";
}

export function fileStem(file: string): string {
    const base = file.split("/").pop() ?? file;
    return base.replace(/\.[^.]+$/, "");
}
