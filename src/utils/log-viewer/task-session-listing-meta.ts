import { existsSync } from "node:fs";
import type { TaskSessionStore } from "@app/task/lib/session-store";
import { SafeJSON } from "@app/utils/json";
import { readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import type { JsonlMetaRecord, JsonlRecord } from "@app/utils/log-session/types";

export interface TaskSessionListingMeta {
    command?: string;
    cwd?: string;
    createdAt?: number;
    lastActivityAt?: number;
}

function jsonlMetaRecord(records: JsonlRecord[]): JsonlMetaRecord | null {
    const record = records.find((entry): entry is JsonlMetaRecord => entry.type === "meta");

    return record ?? null;
}

/**
 * Read the FIRST line of a jsonl file and parse it as a meta record if it
 * matches the meta shape. Avoids reading + parsing the whole file just to
 * fall back from a missing persisted meta.json — for multi-MB sessions
 * this is the difference between O(N) and O(1).
 */
async function firstLineMetaRecord(jsonlPath: string): Promise<JsonlMetaRecord | null> {
    if (!existsSync(jsonlPath)) {
        return null;
    }

    try {
        const text = await Bun.file(jsonlPath).text();
        const newlineIdx = text.indexOf("\n");
        const firstLine = newlineIdx === -1 ? text : text.slice(0, newlineIdx);
        if (!firstLine.trim()) {
            return null;
        }

        const parsed = SafeJSON.parse(firstLine, { jsonl: true }) as JsonlRecord;
        if (parsed && typeof parsed === "object" && (parsed as { type?: string }).type === "meta") {
            return parsed as JsonlMetaRecord;
        }
    } catch {
        // malformed first line — fall through
    }

    return null;
}

export async function resolveTaskSessionListingMeta({
    store,
    name,
    jsonlPath,
    records,
}: {
    store: TaskSessionStore;
    name: string;
    jsonlPath: string;
    records?: JsonlRecord[];
}): Promise<TaskSessionListingMeta> {
    const meta = await store.getSessionMeta(name);

    // Persisted .meta.json wins. It's written on prepareSession and updated
    // on markExited / updatePid, so command + cwd are present in every
    // normal-lifecycle session — no jsonl read needed for listing.
    if (meta?.command !== undefined && meta?.cwd !== undefined) {
        return {
            command: meta.command,
            cwd: meta.cwd,
            createdAt: meta.createdAt,
            lastActivityAt: meta.lastActivityAt,
        };
    }

    // Fallback for sessions whose .meta.json was lost (e.g. dashboard delete
    // race, manual unlink, very old sessions before .meta.json existed). If
    // the caller already parsed records, reuse them; otherwise read only the
    // first line — the meta is always written there.
    const inlineMeta = records !== undefined
        ? jsonlMetaRecord(records)
        : ((await firstLineMetaRecord(jsonlPath)) ?? jsonlMetaRecord(await readJsonlFile(jsonlPath)));

    return {
        command: meta?.command ?? inlineMeta?.command,
        cwd: meta?.cwd ?? inlineMeta?.cwd,
        createdAt: meta?.createdAt,
        lastActivityAt: meta?.lastActivityAt,
    };
}
