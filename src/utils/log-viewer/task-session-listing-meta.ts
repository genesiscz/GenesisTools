import type { TaskSessionStore } from "@app/task/lib/session-store";
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
    const lines = records ?? (await readJsonlFile(jsonlPath));
    const inlineMeta = jsonlMetaRecord(lines);

    return {
        command: meta?.command ?? inlineMeta?.command,
        cwd: meta?.cwd ?? inlineMeta?.cwd,
        createdAt: meta?.createdAt,
        lastActivityAt: meta?.lastActivityAt,
    };
}
