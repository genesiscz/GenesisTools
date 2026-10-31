/**
 * The shared half of `NativeSessionReader.currentModel`: the bounded read and the newest-first scan. Each harness
 * supplies its row probe (`<harness>-model.ts`). Light on purpose: a hook reaches the same function through its
 * harness's hook facts (`HookFacts.currentModel`), so it imports this file and one probe, never a reader.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { requireSibling } from "@genesiscz/utils/fs/module-dir";

/** The newest model sits in the last turn's records; a long tool result between them can push it back. */
export const SESSION_MODEL_TAIL_BYTES = 256 * 1024;

/** The model one row names, and whether the row belongs to a sub-agent's side chain. */
export interface RowModel {
    model: string;
    sidechain: boolean;
}

export type RowModelProbe = (row: string) => RowModel | undefined;

/**
 * The newest model the rows name, newest first. A side-chain row (a sub-agent's, in a parent transcript) counts only
 * when no row of the session's own chain names one: in a sub-agent's own transcript every row is a side-chain row, so
 * that one then answers with its own model, and a parent transcript never answers with a sub-agent's.
 */
export function newestModelIn(lines: readonly string[], probe: RowModelProbe): string | null {
    let sidechain: string | null = null;

    for (let index = lines.length - 1; index >= 0; index--) {
        const found = probe(lines[index].trim());

        if (!found) {
            continue;
        }

        if (!found.sidechain) {
            return found.model;
        }

        sidechain ??= found.model;
    }

    return sidechain;
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

/** The newest model in the last `tailBytes` of a transcript. */
export function newestModelInTail(
    path: string,
    probe: RowModelProbe,
    tailBytes = SESSION_MODEL_TAIL_BYTES
): string | null {
    const lines = windowLines(path, tailBytes, "tail");
    return lines ? newestModelIn(lines, probe) : null;
}

/** The first model in the first `headBytes` of a transcript, for a format that names its model once near the top. */
export function firstModelInHead(path: string, probe: RowModelProbe, headBytes: number): string | null {
    const lines = windowLines(path, headBytes, "head");

    for (const line of lines ?? []) {
        const found = probe(line.trim());

        if (found) {
            return found.model;
        }
    }

    return null;
}
