/**
 * Codex keeps one prompt cache per reasoning effort and per model: a request at another effort re-reads the whole
 * context without the cache (probed 2026-10-27: five requests with one cache key, every effort change missed). In
 * session 8cf9eff2 that cost up to 430K uncached tokens per `/effort`, and nothing said so. This remembers each
 * Claude Code thread's last effort and model, so the proxy can name the change when it happens.
 */

import { createHash } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";

export interface ThreadShape {
    effort: string;
    model: string;
}

const MAX_THREADS = 1024;

const lastShape = new Map<string, ThreadShape>();
const reminders = new Map<string, Array<{ index: number; hash: string; text: string }>>();

function itemHash(item: unknown): string {
    return createHash("sha256")
        .update(SafeJSON.stringify(item) ?? "null")
        .digest("hex");
}

/** Replay notices at their original user messages while those messages remain in the history. */
export function preserveCacheReminders(thread: string, input: unknown[], notice?: string): unknown[] {
    const entries = reminders.get(thread) ?? [];
    const retained = entries.filter((entry) => itemHash(input[entry.index]) === entry.hash);
    if (notice) {
        const index = input.findLastIndex((item) => isObject(item) && item.role === "user");
        if (index >= 0) {
            retained.push({ index, hash: itemHash(input[index]), text: notice });
        }
    }
    reminders.delete(thread);
    if (retained.length > 0) {
        reminders.set(thread, retained);
    }
    while (reminders.size > MAX_THREADS) {
        const oldest = reminders.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        reminders.delete(oldest);
    }
    return input.map((item, index) => {
        const matches = retained.filter((entry) => entry.index === index);
        if (matches.length === 0 || !isObject(item)) {
            return item;
        }
        const content =
            typeof item.content === "string"
                ? [{ type: "input_text", text: item.content }]
                : Array.isArray(item.content)
                  ? [...item.content]
                  : [];
        for (const entry of matches) {
            content.push({ type: "input_text", text: `<system-reminder>\n${entry.text}\n</system-reminder>` });
        }
        return { ...item, content };
    });
}

/** What changed between two requests of one thread. */
export interface ShapeChange {
    what: "effort" | "model";
    from: string;
    to: string;
}

/** Records this request's shape; returns what changed since the thread's previous request. */
export function shapeChange(thread: string, shape: ThreadShape): ShapeChange | undefined {
    const before = lastShape.get(thread);
    lastShape.delete(thread);
    lastShape.set(thread, shape);

    while (lastShape.size > MAX_THREADS) {
        const oldest = lastShape.keys().next().value;

        if (oldest === undefined) {
            break;
        }

        lastShape.delete(oldest);
    }

    if (!before) {
        return undefined;
    }

    if (before.model !== shape.model) {
        return { what: "model", from: before.model, to: shape.model };
    }

    if (before.effort !== shape.effort) {
        return { what: "effort", from: before.effort, to: shape.effort };
    }

    return undefined;
}

/** The event's reason: "effort high -> xhigh". */
export function cacheResetReason(change: ShapeChange): string {
    return `${change.what} ${change.from} -> ${change.to}`;
}

/** What the agent reads in the request where its cache was lost. */
export function cacheResetNotice(change: ShapeChange): string {
    const name = change.what === "effort" ? "reasoning effort" : "model";
    return `The ${name} changed from ${change.from} to ${change.to}. Codex keeps a separate prompt cache for each ${change.what}, so this request may need a full context re-read. If this happens often, tell the user once that these changes can cost a full re-read.`;
}

export function resetCacheShapeForTests(): void {
    lastShape.clear();
    reminders.clear();
}
