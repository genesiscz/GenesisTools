import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { readPrefixMark } from "@genesiscz/utils/ai/transcripts/file-scan";
import { onReleaseMemory } from "@genesiscz/utils/process/release-memory";

export const CHUNK_BYTES = 8 * 1024 * 1024;
const IDLE_MS = 10 * 60_000;

export function changesCache<T>(name: string) {
    const entries = new Map<string, { used: number; state: T }>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sweep = () => {
        timer = undefined;
        for (const [key, entry] of entries) {
            if (entry.used < Date.now() - IDLE_MS) {
                entries.delete(key);
            }
        }
        if (entries.size) {
            timer = setTimeout(sweep, IDLE_MS / 4);
            timer.unref();
        }
    };
    onReleaseMemory(name, () => {
        entries.clear();
        clearTimeout(timer);
        timer = undefined;
    });
    return {
        delete: (key: string) => entries.delete(key),
        get(key: string, create: () => T): T {
            const state = entries.get(key)?.state ?? create();
            entries.delete(key);
            entries.set(key, { used: Date.now(), state });
            const oldest = entries.keys().next().value;
            if (entries.size > 2 && oldest !== undefined) {
                entries.delete(oldest);
            }
            if (!timer) {
                timer = setTimeout(sweep, IDLE_MS / 4);
                timer.unref();
            }
            return state;
        },
    };
}

export interface LineFold<T> {
    ino: number;
    consumed: number;
    start: number;
    mark: string;
    state: T;
    size: number;
    mtime: number;
    ctime: number;
}

/** Only complete newline-delimited records are committed. On failure the caller discards the whole session cache. */
export function advanceLines<T>(options: {
    path: string;
    start?: number;
    kept?: LineFold<T>;
    initial: () => T;
    line: (state: T, bytes: Buffer, offset: number) => void;
}): LineFold<T> {
    const { path, start = 0, kept } = options;
    const fd = openSync(path, "r");
    try {
        const { size, ino, mtimeMs, ctimeMs } = fstatSync(fd);
        if (start > size) {
            throw new Error("cut beyond end of transcript");
        }
        const candidate = kept && kept.start === start && kept.ino === ino && kept.consumed <= size ? kept : undefined;
        let prefix = readPrefixMark(fd, candidate?.consumed ?? start);
        const usable = candidate && candidate.mark === prefix.digest();
        if (candidate && !usable) {
            prefix = readPrefixMark(fd, start);
        }
        const fold = usable
            ? candidate
            : { ino, consumed: start, start, mark: "", state: options.initial(), size, mtime: mtimeMs, ctime: ctimeMs };
        const fragments: Buffer[] = [];
        let offset = fold.consumed;
        while (offset < size) {
            const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - offset));
            const count = readSync(fd, chunk, 0, chunk.length, offset);
            if (!count) {
                throw new Error("transcript shortened during scan");
            }
            const data = chunk.subarray(0, count);
            let from = 0;
            for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, from)) {
                const last = data.subarray(from, end);
                const bytes = fragments.length ? Buffer.concat([...fragments, last]) : last;
                options.line(fold.state, bytes, fold.consumed);
                fragments.length = 0;
                fold.consumed = offset + end + 1;
                from = end + 1;
            }
            if (from < count) {
                fragments.push(data.subarray(from));
            }
            prefix.update(data);
            offset += count;
        }
        if (fragments.length) {
            throw new Error("transcript ends without a newline");
        }
        const mark = prefix.finish();
        if (!mark.stable) {
            throw new Error("transcript changed during scan");
        }
        Object.assign(fold, { mark: mark.digest, size, mtime: mtimeMs, ctime: ctimeMs });
        return fold;
    } finally {
        closeSync(fd);
    }
}
