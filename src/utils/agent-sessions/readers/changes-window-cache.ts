import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { readPrefixMark } from "@genesiscz/utils/ai/transcripts/file-scan";
import { SafeJSON } from "@genesiscz/utils/json";
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

export function sameGeneration(facts: LineFold<unknown>, stat: Stats): boolean {
    return (
        facts.ino === stat.ino &&
        facts.size === stat.size &&
        facts.ctime === stat.ctimeMs &&
        facts.mtime === stat.mtimeMs
    );
}

/** Only complete newline-delimited records are committed. On failure the caller discards the whole session cache. */
export function advanceLines<T>(options: {
    path: string;
    start?: number;
    until?: number;
    kept?: LineFold<T>;
    /** A range read in an already verified generation needs no independent hash of the bytes before its cut. */
    verified?: LineFold<unknown>;
    initial: () => T;
    line: (state: T, bytes: Buffer, offset: number) => void;
}): LineFold<T> {
    const { path, start = 0, kept } = options;
    const fd = openSync(path, "r");
    try {
        const stat = fstatSync(fd);
        const { size, ino, mtimeMs, ctimeMs } = stat;
        if (options.verified && !sameGeneration(options.verified, stat)) {
            throw new Error("transcript changed before range read");
        }
        const until = options.until ?? size;
        if (start > until || until > size) {
            throw new Error("cut beyond end of transcript");
        }
        const candidate = kept && kept.start === start && kept.ino === ino && kept.consumed <= size ? kept : undefined;
        let prefix = options.verified && !candidate ? undefined : readPrefixMark(fd, candidate?.consumed ?? start);
        const usable = candidate && candidate.mark === prefix?.digest();
        if (candidate && !usable) {
            prefix = readPrefixMark(fd, start);
        }
        const fold = usable
            ? candidate
            : { ino, consumed: start, start, mark: "", state: options.initial(), size, mtime: mtimeMs, ctime: ctimeMs };
        const fragments: Buffer[] = [];
        let offset = fold.consumed;
        while (offset < until) {
            const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, until - offset));
            const count = readSync(fd, chunk, 0, chunk.length, offset);
            if (!count) {
                throw new Error("transcript shortened during scan");
            }
            const data = chunk.subarray(0, count);
            let from = 0;
            const newline = data.lastIndexOf(10);
            if (newline !== -1) {
                for (const fragment of fragments) {
                    prefix?.update(fragment);
                }
                prefix?.update(data.subarray(0, newline + 1));
            }
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
            offset += count;
        }
        if (fragments.length) {
            let complete = true;
            try {
                SafeJSON.parse(Buffer.concat(fragments).toString("utf8"), { strict: true });
            } catch {
                complete = false;
            }
            if (complete) {
                throw new Error("complete transcript record without its newline");
            }
        }
        const mark = prefix?.finish();
        if (mark?.stable === false || (options.verified && !sameGeneration(options.verified, fstatSync(fd)))) {
            throw new Error("transcript changed during scan");
        }
        Object.assign(fold, { mark: mark?.digest ?? "", size, mtime: mtimeMs, ctime: ctimeMs });
        return fold;
    } finally {
        closeSync(fd);
    }
}
