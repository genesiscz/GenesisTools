import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadStream, SegmentQueue } from "./download";
import { headersFor } from "./source";

/** A stream of five 1-second segments; each segment's body is its own number repeated, so the output is checkable. */
const SEGMENTS = 5;
const segmentBody = (sequence: number) => new Uint8Array(188).fill(sequence + 1);

/** Per test: how the fixture answers. Reset before each scenario. */
const fixture = {
    /** Segments listed by the first playlist request; later requests list all and end the stream. */
    liveFirst: SEGMENTS,
    failing: new Set<number>(),
    slowMs: 0,
    playlistReads: 0,
    started: new Map<number, number>(),
    running: new Map<number, number>(),
    maxRunning: 0,
    cookies: [] as (string | null)[],
};

function playlist(count: number, ended: boolean): string {
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:1", "#EXT-X-MEDIA-SEQUENCE:0"];

    for (let sequence = 0; sequence < count; sequence++) {
        lines.push("#EXTINF:1.0,", `seg${String(sequence).padStart(3, "0")}.ts`);
    }

    if (ended) {
        lines.push("#EXT-X-ENDLIST");
    }

    return `${lines.join("\n")}\n`;
}

const server = Bun.serve({
    port: 0,
    async fetch(request) {
        const path = new URL(request.url).pathname;

        if (path === "/live/media.m3u8") {
            fixture.playlistReads++;
            const first = fixture.playlistReads === 1;
            return new Response(
                playlist(first ? fixture.liveFirst : SEGMENTS, !first || fixture.liveFirst === SEGMENTS)
            );
        }

        const match = /seg(\d+)\.ts$/.exec(path);

        if (!match) {
            return new Response("not found", { status: 404 });
        }

        const sequence = Number(match[1]);
        fixture.cookies.push(request.headers.get("cookie"));
        fixture.started.set(sequence, (fixture.started.get(sequence) ?? 0) + 1);
        fixture.running.set(sequence, (fixture.running.get(sequence) ?? 0) + 1);
        fixture.maxRunning = Math.max(fixture.maxRunning, fixture.running.get(sequence) ?? 0);

        try {
            if (fixture.slowMs > 0) {
                await Bun.sleep(fixture.slowMs);
            }

            if (fixture.failing.has(sequence)) {
                return new Response("busy", { status: 503 });
            }

            return new Response(segmentBody(sequence));
        } finally {
            fixture.running.set(sequence, (fixture.running.get(sequence) ?? 1) - 1);
        }
    },
});

afterAll(() => server.stop(true));

function reset(overrides: Partial<typeof fixture> = {}) {
    Object.assign(fixture, {
        liveFirst: SEGMENTS,
        failing: new Set<number>(),
        slowMs: 0,
        playlistReads: 0,
        started: new Map(),
        running: new Map(),
        maxRunning: 0,
        cookies: [],
        ...overrides,
    });
}

/** Parts folders a complete download handed to the trash, by the spy below. */
const discarded: string[] = [];

function run({ output, signal, withSource = true }: { output: string; signal?: AbortSignal; withSource?: boolean }) {
    return downloadStream({
        output,
        source: withSource
            ? { playlistUrl: `http://localhost:${server.port}/live/media.m3u8`, headers: { cookie: "session=1" } }
            : undefined,
        concurrency: 3,
        idleTimeoutMs: 10_000,
        retryDelayMs: 1,
        pollIntervalMs: 20,
        discardParts: (dir) => {
            discarded.push(dir);
            return "batch-1";
        },
        backfill: false,
        stitchOnly: false,
        signal: signal ?? new AbortController().signal,
    });
}

function expected(): Buffer {
    const all = new Uint8Array(188 * SEGMENTS);

    for (let sequence = 0; sequence < SEGMENTS; sequence++) {
        all.set(segmentBody(sequence), sequence * 188);
    }

    return Buffer.from(all);
}

describe("downloadStream", () => {
    it("downloads a finished stream and stitches the segments in order", async () => {
        reset();
        const output = join(mkdtempSync(join(tmpdir(), "stream-dl-")), "talk.ts");

        const result = await run({ output });

        expect(result).toMatchObject({ output, segments: SEGMENTS, failed: [], gone: [], ended: true, aborted: false });
        expect(result.partsTrashBatch).toBe("batch-1");
        expect(discarded.at(-1)).toBe(`${output}.parts`);
        expect(Buffer.compare(readFileSync(output), expected())).toBe(0);
    });

    it("never downloads a segment twice at once while a live poll lists it again", async () => {
        // The first poll lists 3 slow segments; the next poll, while they are still downloading, lists all 5 and ends.
        reset({ liveFirst: 3, slowMs: 150 });
        const output = join(mkdtempSync(join(tmpdir(), "stream-dl-")), "live.ts");

        const result = await run({ output });

        expect(fixture.playlistReads).toBeGreaterThanOrEqual(2);
        expect(fixture.maxRunning).toBe(1);
        expect([...fixture.started.values()].every((count) => count === 1)).toBe(true);
        expect(Buffer.compare(readFileSync(output), expected())).toBe(0);
        expect(result.ended).toBe(true);
    });

    it("reports a segment that keeps failing and stitches nothing", async () => {
        reset({ failing: new Set([2]) });
        const output = join(mkdtempSync(join(tmpdir(), "stream-dl-")), "broken.ts");

        const result = await run({ output });

        expect(result.output).toBeNull();
        expect(result.failed).toEqual([2]);
        expect(discarded).not.toContain(`${output}.parts`);
        expect(existsSync(output)).toBe(false);

        // The segment comes back: a rerun from the parts folder alone fetches only it and stitches.
        reset();
        const resumed = await run({ output, withSource: false });

        expect(resumed.failed).toEqual([]);
        expect([...fixture.started.keys()]).toEqual([2]);
        expect(Buffer.compare(readFileSync(output), expected())).toBe(0);
    });

    it("keeps the parts of a stopped run and resumes from them", async () => {
        reset({ slowMs: 200 });
        const output = join(mkdtempSync(join(tmpdir(), "stream-dl-")), "stopped.ts");
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);

        const stopped = await run({ output, signal: controller.signal });

        expect(stopped.aborted).toBe(true);
        expect(existsSync(output)).toBe(false);

        reset();
        const resumed = await run({ output });

        expect(resumed.aborted).toBe(false);
        expect(Buffer.compare(readFileSync(output), expected())).toBe(0);
    });
});

describe("SegmentQueue", () => {
    it("hands out the oldest or the newest, never a held one twice, and takes a re-listed one after finish", async () => {
        const queue = new SegmentQueue();

        for (const sequence of [5, 1, 9, 3, 7]) {
            queue.add(sequence, `seg${sequence}`);
        }

        expect((await queue.next(false))?.sequence).toBe(1);
        expect((await queue.next(true))?.sequence).toBe(9);
        queue.add(1, "seg1");
        expect(queue.size).toBe(3);
        queue.finish(1);
        queue.add(1, "seg1");
        expect((await queue.next(false))?.sequence).toBe(1);
        expect((await queue.next(false))?.sequence).toBe(3);
        queue.close();
        expect((await queue.next(true))?.sequence).toBe(7);
        expect((await queue.next(true))?.sequence).toBe(5);
        expect(await queue.next(true)).toBeNull();
    });
});

describe("headersFor", () => {
    const source = {
        playlistUrl: "https://cdn-a.example.com/live/master.m3u8",
        headers: { cookie: "session=1", authorization: "Bearer t", referer: "https://example.com/" },
    };

    it("sends the credentials to the playlist's own origin", () => {
        expect(headersFor("https://cdn-a.example.com/live/seg1.ts", source)).toEqual(source.headers);
    });

    it("drops the cookies and the Authorization header for another origin", () => {
        expect(headersFor("https://cdn-b.example.net/seg1.ts", source)).toEqual({ referer: "https://example.com/" });
        expect(headersFor("http://cdn-a.example.com/seg1.ts", source)).toEqual({ referer: "https://example.com/" });
    });
});
