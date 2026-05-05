import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LogEntry } from "@app/debugging-master/types";
import { parseJsonlChunk } from "@app/utils/jsonl";
import { FileWatcher } from "@app/utils/storage/fs";

export interface TailerHandlers {
    onEntry: (entry: LogEntry, index: number) => void;
}

/**
 * Watches a JSONL file and emits each newly-appended entry. Composes:
 *  - `FileWatcher` for fs.watch + 300ms poll fallback + truncation handling
 *  - `parseJsonlChunk` for Bun-native JSONL parsing with partial-line buffering
 *
 * Existing on-disk content is *not* replayed — initial offset = current size,
 * initial entry index = current line count. Tailer becomes the single source
 * of truth for live SSE: works whether ingest happens in this process or in
 * another (e.g. dashboard on port A, ingest server on port B).
 */
export class FileTailer {
    private watcher: FileWatcher | null = null;
    private remainder: Buffer<ArrayBuffer> = Buffer.alloc(0);
    private entryIndex = 0;
    private started = false;

    constructor(
        private readonly path: string,
        private readonly handlers: TailerHandlers
    ) {}

    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;

        // FileWatcher.start() calls fs.watch() which throws ENOENT on missing
        // files. Touch the file (and parent dir) so subscribers can connect to
        // sessions before any log has been ingested. Mirrors what `start --serve`
        // POST and DELETE handlers do implicitly.
        this.ensureFileExists();

        const { offset, lineCount } = this.measureCurrent();
        this.entryIndex = lineCount;

        this.watcher = new FileWatcher({
            filePath: this.path,
            onData: (newBytes) => this.handleNewData(newBytes),
        });
        this.watcher.start(offset);
    }

    private ensureFileExists(): void {
        if (existsSync(this.path)) {
            return;
        }
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            // 'wx' = exclusive create — won't truncate if another process raced us
            writeFileSync(this.path, "", { flag: "wx" });
        } catch {
            // EEXIST = lost the race, fine. Other failures bubble up via the
            // watcher.start() call.
        }
    }

    stop(): void {
        this.watcher?.stop();
        this.watcher = null;
        this.remainder = Buffer.alloc(0);
        this.started = false;
    }

    private measureCurrent(): { offset: number; lineCount: number } {
        if (!existsSync(this.path)) {
            return { offset: 0, lineCount: 0 };
        }
        // Chunked newline scan — long-running sessions can grow to many MBs;
        // a single readFileSync would allocate the whole file at once.
        // Open first, then size via fstat to make offset+lineCount a single
        // atomic snapshot — otherwise a writer appending between stat() and
        // the read loop would inflate lineCount past offset, corrupting the
        // tailer's entry index.
        let fd: number | null = null;
        try {
            fd = openSync(this.path, "r");
            const offset = fstatSync(fd).size;
            if (offset === 0) {
                return { offset: 0, lineCount: 0 };
            }

            const buffer = Buffer.alloc(64 * 1024);
            let count = 0;
            let position = 0;
            while (position < offset) {
                const toRead = Math.min(buffer.length, offset - position);
                const bytesRead = readSync(fd, buffer, 0, toRead, position);
                if (bytesRead <= 0) {
                    break;
                }

                for (let i = 0; i < bytesRead; i++) {
                    if (buffer[i] === 0x0a) {
                        count++;
                    }
                }

                position += bytesRead;
            }
            return { offset, lineCount: count };
        } catch {
            return { offset: 0, lineCount: 0 };
        } finally {
            if (fd !== null) {
                try {
                    closeSync(fd);
                } catch {
                    // already closed / partial open
                }
            }
        }
    }

    private handleNewData(newBytes: Buffer): void {
        // FileWatcher resets offset to 0 on truncation, but doesn't notify us
        // explicitly. If we receive a chunk that begins from offset 0 again,
        // the file was cleared — reset our index too.
        const watcherOffset = this.watcher?.currentOffset ?? 0;
        if (watcherOffset === newBytes.length) {
            // Watcher's offset == size of new chunk → it was truncated and
            // re-read from 0. Reset our index/buffer to match.
            this.entryIndex = 0;
            this.remainder = Buffer.alloc(0);
        }

        const result = parseJsonlChunk<LogEntry>(newBytes, this.remainder);
        this.remainder = result.remainder;

        for (const entry of result.values) {
            this.entryIndex++;
            this.handlers.onEntry(entry, this.entryIndex);
        }
    }
}
