import { createHash } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";

/**
 * Where an upstream request first differs from the previous request of the same thread. A prompt cache reads only
 * the unchanged prefix, so this names the cause of a miss: the model or effort (a cache of its own), the
 * instructions, the tools, or the first input item that changed. `none` means the previous request is an exact
 * prefix of this one, so a miss with `none` is the upstream's own (eviction or routing). In session 8cf9eff2 three
 * full misses stayed unexplained because nothing recorded this.
 */
export type PrefixDiff =
    | { part: "first" | "none" | "model" | "effort" | "instructions" | "tools" }
    | { part: "input"; index: number; of: number; itemType: string };

export interface UpstreamShape {
    model: string;
    effort?: string;
    instructions?: unknown;
    tools?: unknown;
    input: unknown[];
}

interface Remembered {
    model: string;
    effort: string;
    instructions: string;
    tools: string;
    items: string[];
}

const MAX_THREADS = 1024;

const lastByThread = new Map<string, Remembered>();

const diffByRequest = new WeakMap<Request, PrefixDiff>();

function hash(value: unknown): string {
    return createHash("sha256")
        .update(SafeJSON.stringify(value) ?? "null")
        .digest("hex")
        .slice(0, 16);
}

function remember(thread: string, shape: Remembered): void {
    lastByThread.delete(thread);
    lastByThread.set(thread, shape);

    while (lastByThread.size > MAX_THREADS) {
        const oldest = lastByThread.keys().next().value;

        if (oldest === undefined) {
            break;
        }

        lastByThread.delete(oldest);
    }
}

/** Compares this request with the thread's previous one and remembers it for the next. */
export function notePrefix(thread: string, shape: UpstreamShape): PrefixDiff {
    const now: Remembered = {
        model: shape.model,
        effort: shape.effort ?? "",
        instructions: hash(shape.instructions),
        tools: hash(shape.tools),
        items: shape.input.map(hash),
    };
    const before = lastByThread.get(thread);
    remember(thread, now);

    if (!before) {
        return { part: "first" };
    }

    for (const part of ["model", "effort", "instructions", "tools"] as const) {
        if (before[part] !== now[part]) {
            return { part };
        }
    }

    const index = before.items.findIndex((item, at) => now.items[at] !== item);

    if (index < 0) {
        return { part: "none" };
    }

    const item = shape.input[index];
    const itemType = isObject(item) ? String(item.type ?? (item.role ? "message" : "unknown")) : "missing";
    return { part: "input", index, of: shape.input.length, itemType };
}

export function setPrefixDiff(req: Request, diff: PrefixDiff): void {
    diffByRequest.set(req, diff);
}

/** The diff the provider noted for this client request, for the ledger row. */
export function prefixDiffFor(req: Request): PrefixDiff | undefined {
    return diffByRequest.get(req);
}
