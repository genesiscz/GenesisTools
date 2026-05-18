import { logFilePathFor } from "@app/question/lib/log-store";
import type { QaEntry } from "@app/question/lib/types";
import { FileTailer } from "@app/utils/fs/file-tailer";

export function todayLogFile(): string {
    return logFilePathFor({ ts: Date.now() });
}

export interface QaStream {
    close(): void;
}

export function createQaStream(file: string, onEntry: (e: QaEntry) => void): QaStream {
    const t = new FileTailer<QaEntry>(file, { onLine: (e) => onEntry(e) });
    t.start();
    return { close: () => t.stop() };
}
