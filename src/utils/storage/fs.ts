import { closeSync, type FSWatcher, openSync, readSync, statSync, watch } from "node:fs";

interface FileWatcherOptions {
    filePath: string;
    onData: (newBytes: Buffer) => void;
    pollInterval?: number;
    debounce?: boolean;
}

/**
 * Watches a single file for new appended bytes.
 * Uses fs.watch for instant kernel-level notifications + setInterval poll as fallback.
 * Designed for append-only files (JSONL, logs). Handles file truncation.
 */
export class FileWatcher {
    private offset = 0;
    private watcher: FSWatcher | null = null;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private checkScheduled = false;

    constructor(private options: FileWatcherOptions) {}

    start(fromOffset?: number): void {
        if (fromOffset !== undefined) {
            this.offset = fromOffset;
        } else {
            try {
                this.offset = statSync(this.options.filePath).size;
            } catch {
                this.offset = 0;
            }
        }

        const debounce = this.options.debounce ?? true;

        this.watcher = watch(this.options.filePath, () => {
            if (debounce) {
                if (!this.checkScheduled) {
                    this.checkScheduled = true;
                    queueMicrotask(() => {
                        this.checkScheduled = false;
                        this.checkForNewData();
                    });
                }
            } else {
                this.checkForNewData();
            }
        });

        const interval = this.options.pollInterval ?? 300;
        this.pollTimer = setInterval(() => this.checkForNewData(), interval);
    }

    stop(): void {
        this.watcher?.close();
        this.watcher = null;

        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    get currentOffset(): number {
        return this.offset;
    }

    isActive(thresholdMs = 10_000): boolean {
        try {
            const mtime = statSync(this.options.filePath).mtimeMs;
            return Date.now() - mtime < thresholdMs;
        } catch {
            return false;
        }
    }

    private checkForNewData(): void {
        let currentSize: number;

        try {
            currentSize = statSync(this.options.filePath).size;
        } catch {
            return;
        }

        if (currentSize < this.offset) {
            this.offset = 0;
        }

        if (currentSize <= this.offset) {
            return;
        }

        const fd = openSync(this.options.filePath, "r");
        const newBytes = Buffer.alloc(currentSize - this.offset);
        readSync(fd, newBytes, 0, newBytes.length, this.offset);
        closeSync(fd);
        this.offset = currentSize;
        this.options.onData(newBytes);
    }
}
