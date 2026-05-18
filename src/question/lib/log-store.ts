import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import type { QaEntry } from "./types";

export function logDir(base?: string): string {
    return base ?? process.env.QUESTION_LOG_BASE ?? join(homedir(), ".genesis-tools", "question", "log");
}

export function logFilePathFor(entry: Pick<QaEntry, "ts">, base?: string): string {
    const d = new Date(entry.ts);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return join(logDir(base), `${day}.jsonl`);
}

export function appendEntry(entry: QaEntry, base?: string): string {
    const file = logFilePathFor(entry, base);
    mkdirSync(logDir(base), { recursive: true });
    // Single-line atomic append (O_APPEND); lock-free under concurrent agents.
    appendFileSync(file, `${SafeJSON.stringify(entry)}\n`);
    return file;
}
