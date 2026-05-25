import { existsSync } from "node:fs";
import { parseJsonl } from "@app/utils/jsonl";
import type { JsonlLineRecord, JsonlRecord } from "./types";

export async function readJsonlFile(path: string): Promise<JsonlRecord[]> {
    if (!existsSync(path)) {
        return [];
    }

    const text = await Bun.file(path).text();
    if (!text.trim()) {
        return [];
    }

    return parseJsonl<JsonlRecord>(text);
}

export function filterLineRecords(records: JsonlRecord[]): JsonlLineRecord[] {
    return records.filter((r): r is JsonlLineRecord => r.type === "line" && typeof r.seq === "number");
}

export function filterFromSeq(lines: JsonlLineRecord[], fromSeq: number): JsonlLineRecord[] {
    return lines.filter((l) => l.seq >= fromSeq);
}

export function filterToSeq(lines: JsonlLineRecord[], toSeq: number): JsonlLineRecord[] {
    return lines.filter((l) => l.seq <= toSeq);
}

export function lastNLines(lines: JsonlLineRecord[], n: number): JsonlLineRecord[] {
    if (n <= 0) {
        return [];
    }

    return lines.slice(-n);
}

export function filterByStream(lines: JsonlLineRecord[], streams: Set<"stdout" | "stderr">): JsonlLineRecord[] {
    return lines.filter((l) => streams.has(l.out));
}
