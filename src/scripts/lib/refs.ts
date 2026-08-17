/**
 * The reference system: print a large value once, never print it again.
 *
 * Ported from the pattern GenesisTools' har-analyzer and debugging-master use
 * (`src/utils/references.ts`). The problem it solves is specific to agents: a
 * multi-turn session re-prints the same 500KB payload every time it is
 * mentioned, and the model pays for it each time.
 *
 * The rule is three lines:
 *   value <= THRESHOLD          print inline, no ref, no bookkeeping
 *   value >  THRESHOLD, unseen  store it, print it IN FULL, tag it [ref:ID]
 *   value >  THRESHOLD, seen    print only [ref:ID] + an 80-char preview + size
 *
 * So the agent sees every large value exactly once, and afterwards refers to it
 * by an id it can expand on demand.
 *
 * Ids are derivable, never random: `n14.ctx` parses back to "node index 14,
 * context field" with no lookup table. An id therefore documents its own target
 * and survives a cache wipe.
 */
import { readFile } from "node:fs/promises";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

/**
 * Values at or below this print inline; a ref would cost more than it saves.
 *
 * Tuned for readability over maximum squeeze. At 200 chars nearly everything
 * became a ref and the previews were too short to identify what they pointed
 * at, which costs a round-trip to re-expand and defeats the purpose. ~1200
 * chars is roughly 300 tokens: small enough not to matter, large enough that
 * most tool results still arrive whole. Override per call via
 * `FormatOptions.threshold`.
 */
export const REF_THRESHOLD = 1200;

/** Long enough to recognise the value, short enough to stay a one-liner. */
export const PREVIEW_LENGTH = 240;

export interface RefEntry {
    preview: string;
    size: number;
    shown: boolean;
}

export type RefStore = Record<string, RefEntry>;

/**
 * Cut at the last natural break in the tail of the window, so a preview ends on
 * a word rather than mid-token. Falls back to a hard cut when there is no break.
 */
export function preview(value: string, length = PREVIEW_LENGTH): string {
    const flat = value.replace(/\s+/g, " ").trim();

    if (flat.length <= length) {
        return flat;
    }

    const window = flat.slice(0, length);
    const breakAt = Math.max(window.lastIndexOf(" "), window.lastIndexOf(","), window.lastIndexOf("]"));

    return `${window.slice(0, breakAt > length / 2 ? breakAt : length)}…`;
}

export interface FormatOptions {
    /** Bypass the ref system entirely and print everything. */
    full?: boolean;
    threshold?: number;
}

export interface Formatted {
    text: string;
    /** Set when this value is tracked by a ref. */
    ref?: string;
    /** True when the full value was emitted this time. */
    emittedFull: boolean;
}

/**
 * Format one value for display, creating or reusing its ref.
 *
 * Mutates `store`, which the caller persists. Kept synchronous and store-in,
 * store-out so a caller can format a whole screen of values and write once.
 */
export function formatValueWithRef(store: RefStore, id: string, value: string, options: FormatOptions = {}): Formatted {
    const threshold = options.threshold ?? REF_THRESHOLD;

    if (options.full) {
        return { text: value, ref: id, emittedFull: true };
    }

    if (value.length <= threshold) {
        return { text: value, emittedFull: true };
    }

    const existing = store[id];

    if (existing?.shown) {
        return {
            text: `[ref:${id}] ${existing.preview} (${existing.size} chars)`,
            ref: id,
            emittedFull: false,
        };
    }

    store[id] = { preview: preview(value), size: value.length, shown: true };
    return { text: `${value}\n[ref:${id}]`, ref: id, emittedFull: true };
}

/** `n14.ctx` → `{ index: 14, field: "ctx" }`. Returns undefined for a non-ref. */
export function parseRef(ref: string): { prefix: string; index: number; field?: string } | undefined {
    const match = /^([a-z]+)(\d+)(?:\.(.+))?$/i.exec(ref.trim());

    if (!match) {
        return undefined;
    }

    return { prefix: match[1]!, index: Number(match[2]), field: match[3] };
}

/** Show the first `limit`, then say how many were left out. Never silently drops. */
export function truncateList(items: string[], limit = 5): string[] {
    if (items.length <= limit) {
        return items;
    }

    return [...items.slice(0, limit), `… +${items.length - limit} more`];
}

export async function loadRefStore(path: string): Promise<RefStore> {
    try {
        return SafeJSON.parse(await readFile(path, "utf-8"), { strict: true }) as RefStore;
    } catch (error) {
        logger.debug({ path, error }, "ref store read fell back to empty");
        return {};
    }
}

/** Atomic write (unique temp per writer), so a crashed or concurrent run cannot publish a half-written store. */
export async function saveRefStore(path: string, store: RefStore): Promise<void> {
    atomicWriteFileSync(path, `${SafeJSON.stringify(store, { strict: true }, 2)}\n`);
}
