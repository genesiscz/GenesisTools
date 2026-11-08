/**
 * A hard size cap for a dashboard's background log, applied by the dashboard process itself.
 *
 * The detached launcher (`detach.ts`) and launchd both point the child's stdout and stderr at
 * `~/.genesis-tools/logs/<key>.bg.log`, and nothing rotates that file. A dev server that prints in a loop
 * fills the disk: claude-history wrote 19.6 GB in three hours on 2026-11-05. The child holds the file open,
 * so deleting it frees nothing; the child trims it in place instead. Every descriptor on the file is in
 * append mode, so after the trim the next write lands at the new end of the file.
 *
 * Node builtins only: `vite.base.ts` loads this module while Vite bundles a dashboard's config.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, writeFileSync } from "node:fs";

/** The first line of a dashboard log session. Readers that show only the current session start at the last one. */
export const LOG_SESSION_MARKER = "--- DashboardApp session ";

export const DASHBOARD_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DASHBOARD_LOG_KEEP_BYTES = 1024 * 1024;
const CHECK_INTERVAL_MS = 30_000;

export interface LogCapOptions {
    maxBytes?: number;
    keepBytes?: number;
    now?: () => Date;
}

/**
 * When `file` is larger than `maxBytes`, rewrite it as a session marker plus its last `keepBytes`, cut at a line
 * start. A line the process writes between the read and the rewrite is lost. Returns true when it trimmed.
 */
export function capLogFile(file: string, opts: LogCapOptions = {}): boolean {
    const maxBytes = opts.maxBytes ?? DASHBOARD_LOG_MAX_BYTES;
    const keepBytes = Math.min(opts.keepBytes ?? DASHBOARD_LOG_KEEP_BYTES, maxBytes);

    if (!existsSync(file)) {
        return false;
    }

    const fd = openSync(file, "r");
    let kept: Buffer;
    let size: number;
    try {
        size = fstatSync(fd).size;
        if (size <= maxBytes) {
            return false;
        }

        const buf = Buffer.alloc(keepBytes);
        const read = readSync(fd, buf, 0, keepBytes, size - keepBytes);
        kept = buf.subarray(0, read);
    } finally {
        closeSync(fd);
    }

    const lineStart = kept.indexOf("\n");
    const tail = lineStart >= 0 ? kept.subarray(lineStart + 1) : kept;
    const at = (opts.now ?? (() => new Date()))().toISOString();
    const marker = `${LOG_SESSION_MARKER}${at} (log trimmed at ${formatMiB(size)}, kept the last ${formatMiB(tail.length)}) ---\n`;
    writeFileSync(file, Buffer.concat([Buffer.from(marker), tail]));
    return true;
}

/** Check `file` now and every 30 s. The timer does not keep the process alive. Returns a stop function. */
export function startLogCap(file: string, opts: LogCapOptions & { intervalMs?: number } = {}): () => void {
    const tick = () => {
        try {
            capLogFile(file, opts);
        } catch (err) {
            process.stderr.write(`[DashboardApp] could not trim the log ${file}: ${String(err)}\n`);
        }
    };

    tick();
    const timer = setInterval(tick, opts.intervalMs ?? CHECK_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
}

function formatMiB(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
