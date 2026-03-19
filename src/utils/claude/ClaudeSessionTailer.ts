import { closeSync, openSync, readSync, statSync } from "node:fs";
import { parseJsonl, parseJsonlChunk } from "@app/utils/jsonl";
import { FileWatcher } from "@app/utils/storage/fs";
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
    onFinished?: () => void;
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
        this.loadHistory();

        if (this.options.follow === false) {
            return;
        }

        this.remainder = Buffer.alloc(0);

        this.watcher = new FileWatcher({
            filePath: this.options.filePath,
            onData: (newBytes) => this.handleNewData(newBytes),
        });

        this.watcher.start();
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

    isActive(): boolean {
        return this.watcher?.isActive() ?? false;
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

    private trackCompletion(record: ConversationMessage): void {
        if (record.type === "user") {
            this.newTurnCount++;
        }

        this.newCallCount++;

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
            if (!this.isActive()) {
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

    private loadHistory(): void {
        let fileContent: Buffer;

        try {
            const size = statSync(this.options.filePath).size;

            if (size === 0) {
                return;
            }

            const fd = openSync(this.options.filePath, "r");
            fileContent = Buffer.alloc(size);
            readSync(fd, fileContent, 0, size, 0);
            closeSync(fd);
        } catch {
            return;
        }

        const allRecords = parseJsonl<ConversationMessage>(fileContent);

        if (allRecords.length === 0) {
            return;
        }

        let startIndex = 0;

        if (this.options.lastTurns !== undefined) {
            startIndex = this.findTurnStart(allRecords, this.options.lastTurns);
        } else if (this.options.lastCalls !== undefined) {
            startIndex = Math.max(0, allRecords.length - this.options.lastCalls);
        }

        for (let i = startIndex; i < allRecords.length; i++) {
            this.options.onRecord(allRecords[i]);
        }
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
}
