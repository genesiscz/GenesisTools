import { closeSync, type FSWatcher, openSync, readSync, statSync, watch } from "node:fs";
import { parseJsonl, parseJsonlChunk } from "@app/utils/jsonl";
import type { AssistantMessage, ConversationMessage } from "./types";

function isAssistantEndTurn(record: ConversationMessage): boolean {
    if (record.type === "assistant") {
        return (record as AssistantMessage).message?.stop_reason === "end_turn";
    }

    // "A" is a shorthand for "assistant" in some JSONL variants
    const raw = record as unknown as { type: string; message?: { stop_reason?: string } };

    if (raw.type === "A") {
        return raw.message?.stop_reason === "end_turn";
    }

    return false;
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
 *
 * Uses fs.watch for instant notifications + 300ms setInterval as safety fallback.
 * Handles partial lines via remainder buffering.
 *
 * Architecture:
 *   fs.watch + poll fallback
 *       | onData(newBytes)
 *       v
 *   parseJsonlChunk<ConversationMessage>(newBytes, remainder)
 *       | values[]
 *       v
 *   emit parsed records via onRecord()
 */
export class ClaudeSessionTailer {
    private offset = 0;
    private remainder: Buffer<ArrayBuffer> = Buffer.alloc(0);
    private watcher: FSWatcher | null = null;
    private pollInterval: ReturnType<typeof setInterval> | null = null;
    private checkScheduled = false;

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

        this.offset = statSync(this.options.filePath).size;
        this.remainder = Buffer.alloc(0);

        this.watcher = watch(this.options.filePath, () => {
            if (!this.checkScheduled) {
                this.checkScheduled = true;
                queueMicrotask(() => {
                    this.checkScheduled = false;
                    this.checkForNewData();
                });
            }
        });

        this.pollInterval = setInterval(() => this.checkForNewData(), 300);
    }

    stop(): void {
        if (this.stopped) {
            return;
        }

        this.stopped = true;
        this.watcher?.close();
        this.watcher = null;

        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }

        if (this.staleTimer) {
            clearTimeout(this.staleTimer);
            this.staleTimer = null;
        }
    }

    isActive(): boolean {
        try {
            const mtime = statSync(this.options.filePath).mtimeMs;
            return Date.now() - mtime < 10_000;
        } catch {
            return false;
        }
    }

    private checkForNewData(): void {
        if (this.stopped) {
            return;
        }

        let currentSize: number;

        try {
            currentSize = statSync(this.options.filePath).size;
        } catch {
            return;
        }

        if (currentSize < this.offset) {
            this.offset = 0;
            this.remainder = Buffer.alloc(0);
        }

        if (currentSize <= this.offset) {
            return;
        }

        const fd = openSync(this.options.filePath, "r");
        const newBytes = Buffer.alloc(currentSize - this.offset);
        readSync(fd, newBytes, 0, newBytes.length, this.offset);
        closeSync(fd);
        this.offset = currentSize;

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

        const isEndTurn = isAssistantEndTurn(record);

        if (isEndTurn) {
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
