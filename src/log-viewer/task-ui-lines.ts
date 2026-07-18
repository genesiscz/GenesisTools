import { existsSync } from "node:fs";
import { FileTailer } from "@app/debugging-master/core/file-tailer";
import { uiJsonlPath } from "@app/task/lib/paths";
import type { JsonlUiLineRecord } from "@app/utils/log-session/types";
import { readUiLineMap } from "@app/utils/log-session/ui-jsonl";
import { sessionKey } from "./session-key";

const uiLineMaps = new Map<string, Map<number, string>>();
const uiTailers = new Map<string, FileTailer>();

export function getTaskUiLineMap(key: string): Map<number, string> {
    let map = uiLineMaps.get(key);

    if (!map) {
        map = new Map();
        uiLineMaps.set(key, map);
    }

    return map;
}

export function lookupTaskUiText(key: string, seq: number): string | undefined {
    return getTaskUiLineMap(key).get(seq);
}

export async function preloadTaskUiLineMap(key: string, sessionName: string): Promise<Map<number, string>> {
    const map = getTaskUiLineMap(key);
    const path = uiJsonlPath(sessionName);

    if (!existsSync(path)) {
        return map;
    }

    const loaded = await readUiLineMap(path);
    for (const [seq, text] of loaded) {
        map.set(seq, text);
    }

    return map;
}

export function ensureTaskUiTailer(sessionName: string, key: string): void {
    if (uiTailers.has(key)) {
        return;
    }

    const path = uiJsonlPath(sessionName);
    const map = getTaskUiLineMap(key);

    const tailer = new FileTailer(path, {
        onEntry: (raw) => {
            // FileTailer's onEntry generic is LogEntry by default; the
            // .ui.jsonl actually carries JsonlUiLineRecord. Bridge via
            // `unknown` so TS accepts the narrowing cast.
            const record = raw as unknown as JsonlUiLineRecord;
            if (record.type !== "line" || typeof record.seq !== "number") {
                return;
            }

            map.set(record.seq, record.text);
        },
        onTruncated: () => {
            map.clear();
        },
    });

    tailer.start();
    uiTailers.set(key, tailer);
}

export function stopTaskUiTailer(key: string): void {
    const tailer = uiTailers.get(key);
    if (!tailer) {
        return;
    }

    tailer.stop();
    uiTailers.delete(key);
    uiLineMaps.delete(key);
}

export function resetTaskUiTailer(key: string, sessionName: string): void {
    stopTaskUiTailer(key);
    getTaskUiLineMap(key).clear();
    ensureTaskUiTailer(sessionName, key);
}

export { sessionKey };
