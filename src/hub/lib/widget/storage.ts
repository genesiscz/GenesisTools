import { join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { type JsonDocument, jsonDocument } from "@genesiscz/utils/storage/locked-document";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { type WidgetState, widgetStateSchema } from "./types";

/** readWidgetState refuses a larger file, so mutateWidgetState never writes one. */
export const MAX_WIDGET_STATE_BYTES = 32 * 1024 * 1024;

export function widgetRoot(root?: string): string {
    return root ? resolve(root) : toolDataDir("hub", "widget");
}
/**
 * `state.json` under `state.lock` (10 s). A file over 32 MiB, or one the schema refuses, throws on read and refuses
 * every change; a change writes only when it changed something, and bumps `revision` when it does.
 */
function widgetStateDocument(directory: string): JsonDocument<WidgetState> {
    return jsonDocument<WidgetState>({
        path: join(directory, "state.json"),
        lockPath: join(directory, "state.lock"),
        lockTimeoutMs: 10_000,
        empty: () => widgetStateSchema.parse({}),
        decode: (raw) => widgetStateSchema.parse(raw),
        maxBytes: MAX_WIDGET_STATE_BYTES,
        encode: (state) => {
            const serialized = SafeJSON.stringify(state);
            // A larger file could never be read again, and every later snapshot, cancel and edit would fail.
            if (Buffer.byteLength(serialized) > MAX_WIDGET_STATE_BYTES) {
                throw new Error("This change was not saved: widget history would exceed 32 MiB");
            }

            return serialized;
        },
        onUnreadable: "refuse",
        beforeWrite: (state) => {
            state.revision += 1;
            widgetStateSchema.parse(state);
        },
        unreadableError: (problem) =>
            problem.kind === "too-large"
                ? new Error("Widget history exceeds 32 MiB; export and clean up old outgoing items")
                : problem.cause instanceof Error
                  ? problem.cause
                  : problem,
    });
}

export async function readWidgetState(root?: string): Promise<WidgetState> {
    return widgetStateDocument(widgetRoot(root)).readAsync();
}

export async function mutateWidgetState<T>(root: string | undefined, update: (state: WidgetState) => T): Promise<T> {
    return widgetStateDocument(widgetRoot(root)).mutate(update);
}

const INBOX_READ_LIMIT = 4096;
const INBOX_READ_RETAINED = 3072;

export async function acknowledgeWidgetInbox({
    root,
    key,
    id,
    at,
    signal,
}: {
    root?: string;
    key: string;
    id: string;
    at: number;
    signal?: AbortSignal;
}): Promise<{ saved: boolean }> {
    return mutateWidgetState(root, (state) => {
        signal?.throwIfAborted();
        const token = `${key}|${id}`;
        if ((state.inboxRead[token] ?? -1) >= at) {
            return { saved: false };
        }

        const entries = Object.entries(state.inboxRead);
        if (!(token in state.inboxRead) && entries.length >= INBOX_READ_LIMIT) {
            // Forget the oldest marks instead of refusing every later read once the history fills up.
            entries.sort((a, b) => a[1] - b[1]);
            for (const [stale] of entries.slice(0, entries.length - INBOX_READ_RETAINED)) {
                delete state.inboxRead[stale];
            }
        }

        state.inboxRead[token] = at;
        return { saved: true };
    });
}
