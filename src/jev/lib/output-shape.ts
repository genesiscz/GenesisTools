/**
 * Default CLI results omit the heavy diagnostic payloads: full Jev evaluation objects with a
 * probability per candidate, and the multi-KB base64 snapshot tokens the native driver returns.
 * `--json` (or `verbose: true`) keeps everything. The stripped keys are named here so the two
 * shapes never drift apart between verbs.
 */
const HEAVY_KEYS = new Set(["evaluation", "probabilities", "snapshot", "observations", "raw"]);

const SNAPSHOT_PREVIEW_CHARS = 16;

export function compactResult<T>(value: T, options: { verbose?: boolean } = {}): T {
    if (options.verbose) {
        return value;
    }

    return strip(value) as T;
}

function strip(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(strip);
    }

    if (value === null || typeof value !== "object") {
        return value;
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (key === "snapshot" && typeof entry === "string" && entry.length > SNAPSHOT_PREVIEW_CHARS) {
            result.snapshotPreview = `${entry.slice(0, SNAPSHOT_PREVIEW_CHARS)}…(${entry.length})`;
            continue;
        }

        if (HEAVY_KEYS.has(key)) {
            continue;
        }

        result[key] = strip(entry);
    }

    return result;
}
