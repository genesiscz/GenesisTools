import type { QuestionConfig } from "../config";
import type { QaEntry } from "../types";

export class SinkError extends Error {
    constructor(
        message: string,
        public readonly remedy?: string
    ) {
        super(message);
        this.name = "SinkError";
    }
}

export interface Sink {
    name: string;
    isEnabled(config: QuestionConfig): boolean;
    emit(entry: QaEntry, config: QuestionConfig): Promise<void> | void;
    /** Optional per-sink fan-out budget (ms). Network sinks (Telegram does a
     *  cold dynamic import + HTTP) need more than the 2s default or they get
     *  cut off by process.exit(0) before delivery. */
    timeoutMs?: number;
}

// SinkResult is defined once, canonically, in ../types (Task 2 — RecordResult.sinks uses it).
// Re-export here so sinks/registry import from one place. Do NOT redefine it.
export type { SinkResult } from "../types";
