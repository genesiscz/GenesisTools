/**
 * `follow` — the live view over the recorder's segment buffer.
 *
 * Rotation-aware by construction: it does not hold one fd like `tail -f`
 * (which silently goes quiet when the recorder rotates segments). Each poll
 * tick it finishes draining the current segment, then hops to a newer one
 * from offset 0. This is the ONLY sanctioned live reader of the buffer.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { parseJsonlChunk } from "@genesiscz/utils/jsonl";
import { logger } from "@genesiscz/utils/logger";
import { RENDER_NEEDS_CAPTURE, type RecordedEvent, type RenderChannel, renderEventLines } from "./channels.ts";
import { captureDir } from "./paths.ts";
import { readRecorderMeta } from "./recorder.ts";
import { listSegments } from "./segments.ts";

const { log } = logger.scoped("chrome-devtools:follow");

/** URL matcher: substring, or /regex/flags. Ported from the old watch verb. */
export function makeMatcher(m?: string): (url: string) => boolean {
    if (!m) {
        return () => true;
    }

    if (m.startsWith("/") && m.lastIndexOf("/") > 0) {
        const i = m.lastIndexOf("/");
        // g/y make test() stateful via lastIndex — a repeated matcher would
        // silently skip every other hit. They add nothing to a boolean test.
        const flags = m.slice(i + 1).replace(/[gy]/g, "");
        const re = new RegExp(m.slice(1, i), flags);

        return (u: string) => re.test(u);
    }

    return (u: string) => u.includes(m);
}

/** Render channels the recorder is not capturing, with the restart command that would add them. */
export function missingCaptureChannels(
    port: number,
    renderChannels: RenderChannel[]
): { channel: RenderChannel; needs: string }[] {
    const meta = readRecorderMeta(port);
    if (!meta) {
        return [];
    }

    const captured = new Set(meta.channels);
    const missing: { channel: RenderChannel; needs: string }[] = [];

    for (const channel of renderChannels) {
        const needs = RENDER_NEEDS_CAPTURE[channel];
        if (needs && !captured.has(needs)) {
            missing.push({ channel, needs });
        }
    }

    return missing;
}

export interface FollowOpts {
    port: number;
    channels: RenderChannel[];
    match?: string;
    /** Replay buffered events from this epoch-ms before going live. */
    sinceMs?: number;
    /** Stop after N seconds; omit = until killed. */
    seconds?: number;
    onLine: (line: string) => void;
    signal?: AbortSignal;
    pollMs?: number;
    /** Capture dir override (tests). Defaults to the port's real dir. */
    dir?: string;
}

export async function follow(opts: FollowOpts): Promise<void> {
    const dir = opts.dir ?? captureDir(opts.port);
    const on = new Set(opts.channels);
    const matches = makeMatcher(opts.match);
    const render = (ev: RecordedEvent) => {
        for (const line of renderEventLines(ev, on, matches)) {
            opts.onLine(line);
        }
    };

    let currentPath: string | null = null;
    let offset = 0;
    let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    // Replay history when asked, and position the live cursor at the end of
    // the newest segment either way (follow never re-prints what it replayed).
    const segments = listSegments(dir);
    if (opts.sinceMs !== undefined) {
        for (const seg of segments) {
            drainFile(seg.path, 0, (ev) => {
                if (ev.t >= (opts.sinceMs ?? 0)) {
                    render(ev);
                }
            });
        }
    }

    const newest = segments.at(-1);
    if (newest) {
        currentPath = newest.path;
        offset = safeSize(newest.path);
    }

    const deadline = opts.seconds ? Date.now() + opts.seconds * 1000 : Infinity;

    while (Date.now() < deadline && !opts.signal?.aborted) {
        const segs = listSegments(dir);
        const latest = segs.at(-1);

        if (currentPath && existsSync(currentPath)) {
            const drained = drainFile(currentPath, offset, render, remainder);
            offset = drained.offset;
            remainder = drained.remainder;
        }

        if (latest && latest.path !== currentPath) {
            // Rotation: the old segment is fully drained above; hop to the new
            // one from byte 0 so nothing written during the hop is lost.
            currentPath = latest.path;
            offset = 0;
            remainder = Buffer.alloc(0);
            const drained = drainFile(currentPath, offset, render, remainder);
            offset = drained.offset;
            remainder = drained.remainder;
        }

        await Bun.sleep(opts.pollMs ?? 300);
    }
}

function safeSize(path: string): number {
    try {
        return statSync(path).size;
    } catch {
        return 0;
    }
}

function drainFile(
    path: string,
    fromOffset: number,
    onEvent: (ev: RecordedEvent) => void,
    remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0)
): { offset: number; remainder: Buffer<ArrayBufferLike> } {
    const size = safeSize(path);
    if (size <= fromOffset) {
        return { offset: fromOffset, remainder };
    }

    let fd: number;
    try {
        fd = openSync(path, "r");
    } catch (err) {
        log.debug({ err, path }, "follow open failed (raced a prune?)");

        return { offset: fromOffset, remainder };
    }

    try {
        const len = size - fromOffset;
        const buf = Buffer.alloc(len);
        const read = readSync(fd, buf, 0, len, fromOffset);
        const parsed = parseJsonlChunk<RecordedEvent>(buf.subarray(0, read), remainder);
        for (const value of parsed.values) {
            onEvent(value);
        }

        return { offset: fromOffset + read, remainder: parsed.remainder };
    } finally {
        closeSync(fd);
    }
}
