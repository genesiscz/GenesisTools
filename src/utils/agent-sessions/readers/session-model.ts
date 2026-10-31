/**
 * The shared half of `NativeSessionReader.currentModel`: the bounded read and the newest-first scan. Each harness
 * supplies its row probe (`<harness>-model.ts`). Light on purpose: a hook reaches the same function through its
 * harness's hook facts (`HookFacts.currentModel`), so it imports this file and one probe, never a reader.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { requireSibling } from "@genesiscz/utils/fs/module-dir";

/**
 * The newest model sits in the last turn's records; a long tool result between them can push it back. 512 KiB is the
 * larger of the two bounds this read replaced (the hook's 256 KiB, the failure log's 512 KiB), so neither caller lost
 * a model; the larger window cost a hook about 0.06 ms more (0.07 to 0.13 ms per read, 2026-10-31).
 */
export const SESSION_MODEL_TAIL_BYTES = 512 * 1024;

/** The model one row names, and whether the row belongs to a sub-agent's side chain. */
export interface RowModel {
    model: string;
    sidechain: boolean;
}

export type RowModelProbe = (row: string) => RowModel | undefined;

/**
 * The newest model the rows name, newest first. A side-chain row is a sub-agent's: it counts only with
 * `acceptSidechain`, which a caller passes for a sub-agent's own transcript (every row there is a side-chain row). A
 * parent transcript never answers with a sub-agent's model: when no row of its own chain is in the window, the model
 * is unknown.
 */
export function newestModelIn(lines: readonly string[], probe: RowModelProbe, acceptSidechain = false): string | null {
    for (let index = lines.length - 1; index >= 0; index--) {
        const found = probe(lines[index].trim());

        if (found && (acceptSidechain || !found.sidechain)) {
            return found.model;
        }
    }

    return null;
}

/** The first or last `bytes` of a transcript. A `.jsonl.zst` one is decompressed by the sibling loaded on demand. */
function readWindow(path: string, bytes: number, from: "head" | "tail"): Buffer {
    if (path.endsWith(".zst")) {
        const exports: unknown = requireSibling(import.meta, "session-model-zstd");
        const zstdWindow: unknown =
            typeof exports === "object" && exports !== null ? Reflect.get(exports, "zstdWindow") : undefined;

        if (typeof zstdWindow !== "function") {
            throw new Error("session-model-zstd exports no zstdWindow");
        }

        const window: unknown = zstdWindow(path, bytes, from);

        if (!Buffer.isBuffer(window)) {
            throw new Error("session-model-zstd returned no buffer");
        }

        return window;
    }

    const fd = openSync(path, "r");

    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, bytes);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, from === "head" ? 0 : size - length);
        return buffer;
    } finally {
        closeSync(fd);
    }
}

/** The lines of a bounded window of a transcript, or null when it cannot be read. */
function windowLines(path: string, bytes: number, from: "head" | "tail"): string[] | null {
    try {
        return readWindow(path, bytes, from).toString("utf8").split("\n");
    } catch {
        // A missing or unreadable transcript names no model; the callers show none. Not logged: the logger costs a
        // hook process about 12 ms to import (measured 2026-10-31), and this runs on every guarded shell call.
        return null;
    }
}

/** The newest model in the last `tailBytes` of a transcript; `acceptSidechain` as in `newestModelIn`. */
export function newestModelInTail(
    path: string,
    probe: RowModelProbe,
    options: { acceptSidechain?: boolean; tailBytes?: number } = {}
): string | null {
    const lines = windowLines(path, options.tailBytes ?? SESSION_MODEL_TAIL_BYTES, "tail");
    return lines ? newestModelIn(lines, probe, options.acceptSidechain) : null;
}

/**
 * The newest model in the first `headBytes` of a transcript, for a session whose newest turn left the tail. When the
 * head and the tail windows meet, that is the session's latest model; past them a turn in between can name a newer one.
 */
export function newestModelInHead(path: string, probe: RowModelProbe, headBytes: number): string | null {
    const lines = windowLines(path, headBytes, "head");
    return lines ? newestModelIn(lines, probe) : null;
}
