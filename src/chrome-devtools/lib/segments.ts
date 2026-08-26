/**
 * Time-boxed capture segments. One writer per recorder: 30-minute jsonl
 * segments, opportunistic pruning at rotation (a single unlink inside the
 * recorder — no timer process, never blocks event writes), and a per-port
 * byte cap that drops the OLDEST segment early and leaves a marker event.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { RecordedEvent } from "./channels.ts";

const log = logger.child({ component: "chrome-devtools:segments" });

export const SEGMENT_ROTATE_MS = 30 * 60 * 1000;
export const SEGMENT_MAX_AGE_MS = 4 * 60 * 60 * 1000;
export const CAPTURE_CAP_BYTES = 500 * 1024 * 1024;

const SEGMENT_RE = /^seg-(\d+)\.jsonl$/;

export function segmentName(startMs: number): string {
    return `seg-${startMs}.jsonl`;
}

export function parseSegmentStart(name: string): number | null {
    const m = name.match(SEGMENT_RE);

    return m ? Number(m[1]) : null;
}

export interface SegmentInfo {
    path: string;
    name: string;
    startMs: number;
    bytes: number;
}

export function listSegments(dir: string): SegmentInfo[] {
    if (!existsSync(dir)) {
        return [];
    }

    const out: SegmentInfo[] = [];
    for (const name of readdirSync(dir)) {
        const startMs = parseSegmentStart(name);
        if (startMs === null) {
            continue;
        }

        const path = join(dir, name);
        try {
            out.push({ path, name, startMs, bytes: statSync(path).size });
        } catch (err) {
            log.debug({ err, path }, "segment stat failed (raced a prune?)");
        }
    }

    return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Pure decision: which segments to delete for age and cap. Exported for tests.
 *
 * Age: rotation happens ON WRITE, so a segment's content ends at most
 * `rotateMs` after its start — it is prunable once `startMs + rotateMs` is
 * older than maxAge. The writer calls this at rotation time, when every
 * listed segment is already closed, so age may drop all of them.
 * Cap: drops the oldest but always keeps at least one (the active segment).
 */
export function pruneDecision(
    segments: SegmentInfo[],
    now: number,
    opts: { maxAgeMs: number; capBytes: number; rotateMs?: number }
): { drop: SegmentInfo[]; capDropped: boolean } {
    const rotateMs = opts.rotateMs ?? SEGMENT_ROTATE_MS;
    const drop = segments.filter((s) => now - s.startMs > opts.maxAgeMs + rotateMs);
    const rest = segments.filter((s) => !drop.includes(s));

    let capDropped = false;
    let total = rest.reduce((sum, s) => sum + s.bytes, 0);
    while (total > opts.capBytes && rest.length > 1) {
        const oldest = rest.shift();
        if (!oldest) {
            break;
        }

        drop.push(oldest);
        total -= oldest.bytes;
        capDropped = true;
    }

    return { drop, capDropped };
}

export class SegmentWriter {
    private fd: number | null = null;
    private segStartMs = 0;
    private currentPath = "";
    private bytesInSegment = 0;

    constructor(
        private readonly dir: string,
        private readonly opts: {
            rotateMs?: number;
            maxAgeMs?: number;
            capBytes?: number;
            now?: () => number;
        } = {}
    ) {}

    private now(): number {
        return this.opts.now ? this.opts.now() : Date.now();
    }

    write(event: RecordedEvent): void {
        const now = this.now();
        const capBytes = this.opts.capBytes ?? CAPTURE_CAP_BYTES;

        // Rotate on the clock, or early when the ACTIVE segment alone reaches
        // HALF the cap. Half, because the cap is a TOTAL-on-disk promise:
        // closed segments are pruned to <= cap/2 (see rotate), and the active
        // segment is bounded to <= cap/2 here, so the sum never exceeds cap.
        if (
            this.fd === null ||
            now - this.segStartMs >= (this.opts.rotateMs ?? SEGMENT_ROTATE_MS) ||
            this.bytesInSegment >= capBytes / 2
        ) {
            this.rotate(now);
        }

        if (this.fd !== null) {
            const line = `${SafeJSON.stringify(event, { strict: true })}\n`;
            writeSync(this.fd, line);
            this.bytesInSegment += line.length;
        }
    }

    private rotate(now: number): void {
        if (this.fd !== null) {
            closeSync(this.fd);
            this.fd = null;
        }

        this.bytesInSegment = 0;

        // Closed segments get half the total budget; the other half belongs to
        // the active segment (write() rotates it at cap/2), so the on-disk sum
        // stays within the promised cap instead of transiently doubling it.
        const { drop, capDropped } = pruneDecision(listSegments(this.dir), now, {
            maxAgeMs: this.opts.maxAgeMs ?? SEGMENT_MAX_AGE_MS,
            capBytes: (this.opts.capBytes ?? CAPTURE_CAP_BYTES) / 2,
            rotateMs: this.opts.rotateMs ?? SEGMENT_ROTATE_MS,
        });

        for (const seg of drop) {
            try {
                unlinkSync(seg.path);
            } catch (err) {
                log.debug({ err, path: seg.path }, "segment prune failed");
            }
        }

        this.segStartMs = now;
        this.currentPath = join(this.dir, segmentName(now));
        // 0600: segments carry live cookies/tokens; other local users must not read them.
        this.fd = openSync(this.currentPath, "a", 0o600);

        if (capDropped) {
            writeSync(
                this.fd,
                `${SafeJSON.stringify(
                    {
                        method: "Genesis.marker",
                        params: { kind: "capDropped", detail: "oldest segment dropped over the byte cap" },
                        t: now,
                    },
                    { strict: true }
                )}\n`
            );
        }
    }

    get segmentPath(): string {
        return this.currentPath;
    }

    close(): void {
        if (this.fd !== null) {
            closeSync(this.fd);
            this.fd = null;
        }
    }
}

/** Read buffered events across all segments, oldest first. Broken lines are skipped, never fatal. */
export function readEvents(dir: string, opts: { sinceMs?: number } = {}): RecordedEvent[] {
    const events: RecordedEvent[] = [];

    for (const seg of listSegments(dir)) {
        let text: string;
        try {
            text = readFileSync(seg.path, "utf8");
        } catch (err) {
            log.debug({ err, path: seg.path }, "segment read failed (raced a prune?)");
            continue;
        }

        for (const line of text.split("\n")) {
            if (!line.trim()) {
                continue;
            }

            try {
                const parsed = SafeJSON.parse(line, { strict: true }) as RecordedEvent;
                if (opts.sinceMs !== undefined && parsed.t < opts.sinceMs) {
                    continue;
                }

                events.push(parsed);
            } catch (err) {
                log.debug({ err, path: seg.path }, "broken jsonl line skipped");
            }
        }
    }

    return events;
}
