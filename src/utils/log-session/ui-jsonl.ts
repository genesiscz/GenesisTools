import { readJsonlFile } from "./jsonl-reader";
import type { JsonlRecord, JsonlUiLineRecord } from "./types";

export function isJsonlUiLineRecord(record: JsonlRecord): record is JsonlUiLineRecord {
    return record.type === "line" && typeof (record as JsonlUiLineRecord).seq === "number";
}

export function filterUiLineRecords(records: JsonlRecord[]): JsonlUiLineRecord[] {
    return records.filter(isJsonlUiLineRecord);
}

export async function readUiLineMap(uiJsonlPath: string): Promise<Map<number, string>> {
    const map = new Map<number, string>();

    try {
        const records = await readJsonlFile(uiJsonlPath);
        for (const record of filterUiLineRecords(records)) {
            map.set(record.seq, record.text);
        }
    } catch {
        // missing ui file — older sessions or non-task sources
    }

    return map;
}
