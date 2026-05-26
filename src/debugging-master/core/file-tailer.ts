import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LogEntry } from "@app/debugging-master/types";
import { parseJsonlChunk } from "@app/utils/jsonl";
import { FileWatcher } from "@app/utils/storage/fs";

export interface TailerHandlers {
    onEntry: (entry: LogEntry, index: number) => void;
    onTruncated?: () => void;
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

        try {
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
                onTruncated: () => {
                    this.entryIndex = 0;
                    this.remainder = Buffer.alloc(0);
                    this.handlers.onTruncated?.();
                },
            });
            this.watcher.start(offset);
        } catch (err) {
            // Roll back so a transient setup failure (FS race, permission glitch)
            // doesn't leave the tailer permanently no-op'd on every later start().
            this.started = false;
            this.watcher = null;
            this.remainder = Buffer.alloc(0);
            this.entryIndex = 0;
            throw err;
        }
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
                    // Mid-read truncation — return what we actually scanned so
                    // the watcher's starting offset matches the file's real
                    // size, instead of pinning to the stale fstat snapshot.
                    return { offset: position, lineCount: count };
                }

                for (let i = 0; i < bytesRead; i++) {
                    if (buffer[i] === 0x0a) {
                        count++;
                    }
                }

                position += bytesRead;
            }
            return { offset, lineCount: count };
        } catch (err) {
            // Only normalize "file is gone" to a zero baseline. Other errors
            // (EACCES, EIO, EBADF) are real failures — let them propagate so
            // start()'s rollback path can surface them instead of silently
            // skipping replay state.
            if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
                return { offset: 0, lineCount: 0 };
            }

            throw err;
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
        const result = parseJsonlChunk<LogEntry>(newBytes, this.remainder);
        this.remainder = result.remainder;

        for (const entry of result.values) {
            this.entryIndex++;
            this.handlers.onEntry(entry, this.entryIndex);
        }
    }
}
