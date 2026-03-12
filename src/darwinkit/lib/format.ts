import { SafeJSON } from "@app/utils/json";
import pc from "picocolors";

export type OutputFormat = "json" | "pretty" | "raw";

/**
 * Detect default format: pretty for TTY, json for piped
 */
export function defaultFormat(): OutputFormat {
    return process.stdout.isTTY ? "pretty" : "json";
}

/**
 * Format any result for output
 */
export function formatOutput(data: unknown, format: OutputFormat): string {
    switch (format) {
        case "json":
            return SafeJSON.stringify(data, null, 2);
        case "raw":
            return formatRaw(data);
        case "pretty":
            return formatPretty(data);
    }
}

function formatRaw(data: unknown): string {
    if (data === null || data === undefined) {
        return "";
    }

    if (typeof data === "string") {
        return data;
    }

    if (typeof data === "number" || typeof data === "boolean") {
        return String(data);
    }

    if (Array.isArray(data)) {
        return data.map((item) => formatRaw(item)).join("\n");
    }

    // For objects with a single obvious "value" field, extract it
    if (typeof data === "object") {
        const obj = data as Record<string, unknown>;

        // Common single-value results
        if ("text" in obj && Object.keys(obj).length <= 2) {
            return String(obj.text);
        }

        if ("content" in obj && Object.keys(obj).length <= 1) {
            return String(obj.content);
        }

        // Fall back to JSON for complex objects
        return SafeJSON.stringify(data, null, 2);
    }

    return String(data);
}

function formatPretty(data: unknown): string {
    if (data === null || data === undefined) {
        return pc.dim("(empty)");
    }

    if (typeof data === "string") {
        return data;
    }

    if (typeof data === "number" || typeof data === "boolean") {
        return pc.cyan(String(data));
    }

    if (Array.isArray(data)) {
        if (data.length === 0) {
            return pc.dim("(empty array)");
        }

        // Array of objects → table-like output
        if (typeof data[0] === "object" && data[0] !== null) {
            return data
                .map((item, i) => {
                    const prefix = pc.dim(`[${i}] `);
                    const fields = Object.entries(item as Record<string, unknown>)
                        .map(([k, v]) => `  ${pc.bold(k)}: ${formatValue(v)}`)
                        .join("\n");
                    return `${prefix}\n${fields}`;
                })
                .join("\n");
        }

        return data.map((item) => `  ${formatValue(item)}`).join("\n");
    }

    if (typeof data === "object") {
        const obj = data as Record<string, unknown>;
        return Object.entries(obj)
            .map(([k, v]) => `${pc.bold(k)}: ${formatValue(v)}`)
            .join("\n");
    }

    return String(data);
}

function formatValue(value: unknown): string {
    if (value === null || value === undefined) {
        return pc.dim("null");
    }

    if (typeof value === "string") {
        return pc.green(`"${value}"`);
    }

    if (typeof value === "number") {
        return pc.cyan(String(value));
    }

    if (typeof value === "boolean") {
        return value ? pc.green("true") : pc.red("false");
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return pc.dim("[]");
        }

        if (value.length <= 5 && value.every((v) => typeof v !== "object")) {
            return `[${value.map((v) => formatValue(v)).join(", ")}]`;
        }

        return `[${value.length} items]`;
    }

    if (typeof value === "object") {
        return SafeJSON.stringify(value);
    }

    return String(value);
}
