import { closeSync, openSync, readSync, statSync } from "node:fs";
import { parseJsonl, parseJsonlChunk } from "@app/utils/jsonl";
import { FileWatcher } from "@app/utils/storage/fs";
import type { IncludeSpec } from "./cli/dsl";
import type { ConversationMessage } from "./types";

/** Shape of the shorthand "A" variant that some JSONL sessions use for assistant. */
interface ShorthandAssistant {
    type: "A";
    message?: { stop_reason?: string | null };
}

function isAssistantEndTurn(record: ConversationMessage): boolean {
    if (record.type === "assistant") {
        return record.message?.stop_reason === "end_turn";
    }

    // parseJsonlChunk casts to ConversationMessage, but some sessions use
    // shorthand type "A" for assistant — falls outside the discriminated union.
    const raw = record as unknown as ShorthandAssistant;

    if (raw.type !== "A") {
        return false;
    }

    return raw.message?.stop_reason === "end_turn";
}

interface TailerOptions {
    filePath: string;
    onRecord: (record: ConversationMessage) => void;
    onFinished?: () => void | Promise<void>;
    includeSpec?: IncludeSpec;
    lastTurns?: number;
    lastCalls?: number;
    maxTurns?: number;
    maxCalls?: number;
    follow?: boolean;
    stopOnFinish?: boolean;
    isAgent?: boolean;
}

/**
 * Streams JSONL records from a Claude session/agent file.
 * Composes FileWatcher for fs.watch + poll fallback, adds JSONL parsing on top.
 */
export class ClaudeSessionTailer {
    private remainder: Buffer<ArrayBuffer> = Buffer.alloc(0);
    private watcher: FileWatcher | null = null;

    private newTurnCount = 0;
    private newCallCount = 0;
    private staleTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;

    constructor(private options: TailerOptions) {}

    async start(): Promise<void> {
        const historyOffset = this.loadHistory();

        if (this.options.follow === false) {
            return;
        }

        this.remainder = Buffer.alloc(0);

        this.watcher = new FileWatcher({
            filePath: this.options.filePath,
            onData: (newBytes) => this.handleNewData(newBytes),
        });

        this.watcher.start(historyOffset);
    }

    stop(): void {
        if (this.stopped) {
            return;
        }

        this.stopped = true;
        this.watcher?.stop();
        this.watcher = null;

        if (this.staleTimer) {
            clearTimeout(this.staleTimer);
            this.staleTimer = null;
        }
    }

    isActive(thresholdMs?: number): boolean {
        return this.watcher?.isActive(thresholdMs) ?? false;
    }

    private handleNewData(newBytes: Buffer): void {
        if (this.stopped) {
            return;
        }

        const result = parseJsonlChunk<ConversationMessage>(newBytes, this.remainder);
        this.remainder = result.remainder;

        for (const record of result.values) {
            this.options.onRecord(record);
            this.trackCompletion(record);

            if (this.shouldStop()) {
                this.stop();
                this.options.onFinished?.();
                return;
            }
        }
    }

    /**
     * A record is displayable if the formatter would actually render it.
     * Non-visible record types (progress, system, queue-operation, etc.) are skipped.
     */
    private isDisplayableRecord(record: ConversationMessage): boolean {
        const type = record.type as string;
        return type === "user" || type === "assistant" || type === "A" || type === "subagent";
    }

    private trackCompletion(record: ConversationMessage): void {
        if (record.type === "user") {
            this.newTurnCount++;
        }

        if (this.isDisplayableRecord(record)) {
            this.newCallCount++;
        }

        if (isAssistantEndTurn(record)) {
            this.scheduleStaleCheck();
        }
    }

    private scheduleStaleCheck(): void {
        if (!this.options.stopOnFinish) {
            return;
        }

        if (this.staleTimer) {
            clearTimeout(this.staleTimer);
        }

        const timeout = this.options.isAgent ? 5_000 : 30_000;
        this.staleTimer = setTimeout(() => {
            if (!this.isActive(timeout)) {
                this.stop();
                this.options.onFinished?.();
            }
        }, timeout);
    }

    private shouldStop(): boolean {
        if (this.options.maxTurns && this.newTurnCount >= this.options.maxTurns) {
            return true;
        }

        if (this.options.maxCalls && this.newCallCount >= this.options.maxCalls) {
            return true;
        }

        return false;
    }

    private loadHistory(): number {
        let fileContent: Buffer;
        let size: number;

        try {
            size = statSync(this.options.filePath).size;

            if (size === 0) {
                return 0;
            }

            const fd = openSync(this.options.filePath, "r");
            fileContent = Buffer.alloc(size);
            readSync(fd, fileContent, 0, size, 0);
            closeSync(fd);
        } catch {
            return 0;
        }

        const allRecords = parseJsonl<ConversationMessage>(fileContent);

        if (allRecords.length === 0) {
            return size;
        }

        let startIndex = 0;

        if (this.options.lastTurns !== undefined) {
            startIndex = this.findTurnStart(allRecords, this.options.lastTurns);
        } else if (this.options.lastCalls !== undefined) {
            startIndex = this.findCallStart(allRecords, this.options.lastCalls);
        }

        for (let i = startIndex; i < allRecords.length; i++) {
            this.options.onRecord(allRecords[i]);
        }

        // t21: Seed completion detection — if the last record looks like a finished
        // session and stopOnFinish is set, schedule a stale check immediately.
        const lastRecord = allRecords[allRecords.length - 1];

        if (this.options.stopOnFinish && isAssistantEndTurn(lastRecord)) {
            this.scheduleStaleCheck();
        }

        return size;
    }

    private findTurnStart(records: ConversationMessage[], lastTurns: number): number {
        const turnStarts: number[] = [];

        for (let i = 0; i < records.length; i++) {
            if (records[i].type === "user") {
                turnStarts.push(i);
            }
        }

        if (turnStarts.length <= lastTurns) {
            return 0;
        }

        return turnStarts[turnStarts.length - lastTurns];
    }

    private findCallStart(records: ConversationMessage[], lastCalls: number): number {
        const displayableIndices: number[] = [];

        for (let i = 0; i < records.length; i++) {
            if (this.isDisplayableRecord(records[i])) {
                displayableIndices.push(i);
            }
        }

        if (displayableIndices.length <= lastCalls) {
            return 0;
        }

        return displayableIndices[displayableIndices.length - lastCalls];
    }
}
