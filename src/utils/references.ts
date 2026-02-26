import { Storage } from "@app/utils/storage/storage";

export interface RefEntry {
    preview: string;
    size: number;
    shown: boolean;
}

export interface RefStore {
    refs: Record<string, RefEntry>;
}

export const REF_THRESHOLD = 200;
export const PREVIEW_LENGTH = 80;

const REFS_TTL = "1 day";

/**
 * Generate a preview string from a value.
 * Returns the first PREVIEW_LENGTH chars, trimmed at the last natural break
 * (space, comma, or bracket) before the limit if possible.
 */
export function generatePreview(value: string): string {
    if (value.length <= PREVIEW_LENGTH) {
        return value;
    }

    let cutoff = PREVIEW_LENGTH;

    const breakChars = [" ", ",", "]", "}", ")"];
    let lastBreak = -1;
    for (let i = cutoff - 1; i >= Math.floor(cutoff * 0.5); i--) {
        if (breakChars.includes(value[i])) {
            lastBreak = i + 1;
            break;
        }
    }

    if (lastBreak > 0) {
        cutoff = lastBreak;
    }

    return `${value.slice(0, cutoff)}...`;
}

/**
 * Format a value using the ref system.
 *
 * - If `options.full` is true, always return the full content (bypass ref system).
 * - If value is shorter than REF_THRESHOLD, return as-is (no ref created).
 * - If the ref was already shown, return a compact reference with preview.
 * - If the ref is new or not yet shown, store it and return the full value with ref tag.
 */
export function formatValueWithRef(
    value: string,
    refId: string,
    refs: RefStore,
    options?: { full?: boolean }
): { formatted: string; updated: boolean } {
    if (options?.full) {
        return { formatted: value, updated: false };
    }

    if (value.length <= REF_THRESHOLD) {
        return { formatted: value, updated: false };
    }

    const existing = refs.refs[refId];

    if (existing?.shown) {
        const preview = generatePreview(value);
        return { formatted: `[ref:${refId}] ${preview} (${value.length} chars)`, updated: false };
    }

    refs.refs[refId] = {
        preview: generatePreview(value),
        size: value.length,
        shown: true,
    };

    return { formatted: `[ref:${refId}] ${value}`, updated: true };
}

export class RefStoreManager {
    sessionId: string;
    protected storage: Storage;
    protected refsPath: string;

    constructor(toolName: string, sessionId: string) {
        this.sessionId = sessionId;
        this.storage = new Storage(toolName);
        this.refsPath = `sessions/${sessionId}.refs.json`;
    }

    async load(): Promise<RefStore> {
        const cached = await this.storage.getCacheFile<RefStore>(this.refsPath, REFS_TTL);
        if (cached) {
            return cached;
        }
        return { refs: {} };
    }

    async save(store: RefStore): Promise<void> {
        await this.storage.putCacheFile(this.refsPath, store, REFS_TTL);
    }

    async formatValue(value: string, refId: string, options?: { full?: boolean }): Promise<string> {
        const store = await this.load();
        const { formatted, updated } = formatValueWithRef(value, refId, store, options);
        if (updated) {
            await this.save(store);
        }
        return formatted;
    }

    async getRef(refId: string): Promise<RefEntry | null> {
        const store = await this.load();
        return store.refs[refId] ?? null;
    }

    async expand(refId: string): Promise<{ found: boolean; refId: string; preview: string; size: number } | null> {
        const entry = await this.getRef(refId);
        if (!entry) {
            return null;
        }

        return {
            found: true,
            refId,
            preview: entry.preview,
            size: entry.size,
        };
    }

    generatePreview(value: string): string {
        return generatePreview(value);
    }
}
