import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "@app/logger";
import { parseJsonlChunk } from "@app/utils/jsonl";

const log = logger.child({ component: "fs:file-tailer" });

export interface FileTailerHandlers<T> {
    onLine: (entry: T, index: number) => void;
}

const FINGERPRINT_BYTES = 64;

function fstatSyncSize(path: string): number {
    const fd = openSync(path, "r");
    try {
        return fstatSync(fd).size;
    } finally {
        closeSync(fd);
    }
}

/** Hex of the first N bytes — detects in-place rewrites that don't shrink the file. */
function headFingerprint(path: string): string {
    const fd = openSync(path, "r");
    try {
        const size = fstatSync(fd).size;
        const n = Math.min(FINGERPRINT_BYTES, size);
        if (n === 0) {
            return "";
        }

        const buf = Buffer.alloc(n);
        readSync(fd, buf, 0, n, 0);
        return buf.toString("hex");
    } finally {
        closeSync(fd);
    }
}

/**
 * Watches a JSONL file and emits each newly-appended entry. Generalized from
 * ClaudeSessionTailer: byte-offset reads + parseJsonlChunk remainder buffering
 * + truncation reset. Pre-existing content is NOT replayed (offset starts at
 * current size). No daemon — fs.watch + a 300ms safety poll.
 */
export class FileTailer<T = unknown> {
    private offset = 0;
    private index = 0;
    private remainder: Buffer = Buffer.alloc(0);
    private fingerprint = "";
    private fsWatcher: ReturnType<typeof watch> | null = null;
    private poll: ReturnType<typeof setInterval> | null = null;
    private started = false;

    constructor(
        private readonly path: string,
        private readonly handlers: FileTailerHandlers<T>
    ) {}

    start(): void {
        if (this.started) {
            return;
        }

        this.started = true;
        if (!existsSync(this.path)) {
            mkdirSync(dirname(this.path), { recursive: true });
            try {
                writeFileSync(this.path, "", { flag: "wx" });
            } catch {
                /* race: another writer created it — fine */
            }
        }

        this.offset = existsSync(this.path) ? fstatSyncSize(this.path) : 0;
        this.fingerprint = existsSync(this.path) ? headFingerprint(this.path) : "";
        const tick = (): void => this.drain();
        try {
            this.fsWatcher = watch(this.path, tick);
        } catch (err) {
            log.debug({ err, path: this.path }, "fs.watch failed; poll-only");
        }

        this.poll = setInterval(tick, 300);
    }

    stop(): void {
        this.fsWatcher?.close();
        this.fsWatcher = null;
        if (this.poll) {
            clearInterval(this.poll);
        }

        this.poll = null;
        this.started = false;
    }

    private drain(): void {
        if (!existsSync(this.path)) {
            return;
        }

        const size = fstatSyncSize(this.path);
        const fp = headFingerprint(this.path);
        // Pure append keeps the head bytes intact, so the old/new head hex are
        // prefix-compatible (one is a prefix of the other). A rewrite ("cleared
        // then re-appended") changes the head, breaking that — even when the
        // new file is the same length or longer. Shrink is also a reset.
        const headRewritten =
            this.offset > 0 &&
            this.fingerprint !== "" &&
            !fp.startsWith(this.fingerprint) &&
            !this.fingerprint.startsWith(fp);
        if (size < this.offset || headRewritten) {
            this.offset = 0;
            this.index = 0;
            this.remainder = Buffer.alloc(0);
        }

        // Keep the longest head seen so it stabilises at FINGERPRINT_BYTES.
        if (fp.length >= this.fingerprint.length || headRewritten) {
            this.fingerprint = fp;
        }
        if (size === this.offset) {
            return;
        }

        const fd = openSync(this.path, "r");
        try {
            const len = size - this.offset;
            const buf = Buffer.alloc(len);
            const read = readSync(fd, buf, 0, len, this.offset);
            this.offset += read;
            const { values, remainder } = parseJsonlChunk<T>(buf.subarray(0, read), this.remainder);
            this.remainder = remainder;
            for (const v of values) {
                this.index++;
                try {
                    this.handlers.onLine(v, this.index);
                } catch (err) {
                    log.warn({ err }, "FileTailer onLine handler threw (isolated)");
                }
            }
        } finally {
            closeSync(fd);
        }
    }
}
