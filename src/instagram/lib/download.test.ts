import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { downloadReels, summarizeDownloads } from "./download";
import type { StoryItem, StoryReel } from "./types";

const realFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(async () => {
    globalThis.fetch = realFetch;

    for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

async function scratchDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "instagram-download-"));
    dirs.push(dir);
    return dir;
}

function storyItem(overrides: Partial<StoryItem> = {}): StoryItem {
    return {
        id: "item1",
        takenAt: new Date("2026-07-27T10:00:00Z"),
        isVideo: false,
        mediaUrl: "https://cdn/img.jpg",
        imageUrl: "https://cdn/img.jpg",
        width: 1080,
        height: 1920,
        ...overrides,
    };
}

function reelWith(item: StoryItem, ownerUsername?: string): StoryReel {
    return { reelId: "123", ownerUsername, items: [item] };
}

function mockBody(payload: Uint8Array<ArrayBuffer>): void {
    globalThis.fetch = mock(async () => new Response(payload, { status: 200 })) as unknown as typeof fetch;
}

describe("downloadReels", () => {
    test("streams the body to disk and reports the byte count it actually wrote", async () => {
        // The body arrives as a stream rather than one buffer, which is the whole
        // point: a story video must never be materialised whole in memory first.
        const payload = new Uint8Array(64 * 1024).fill(7);
        mockBody(payload);
        const dir = await scratchDir();

        const results = await downloadReels([reelWith(storyItem(), "someone")], dir);

        expect(results).toHaveLength(1);
        expect(results[0].bytes).toBe(payload.byteLength);

        const written = await Bun.file(results[0].path).bytes();
        expect(written.byteLength).toBe(payload.byteLength);
        expect(written[0]).toBe(7);
    });

    test("keeps a hostile username or item id from escaping the output directory", async () => {
        // Both halves of the name come from Instagram's JSON, so they are remote
        // input reaching `join()`, where a `..` segment would otherwise walk out.
        mockBody(new Uint8Array([1, 2, 3]));
        const dir = await scratchDir();

        const results = await downloadReels([reelWith(storyItem({ id: "../evil" }), "../../escape")], dir);

        expect(results).toHaveLength(1);
        expect(join(dir, basename(results[0].path))).toBe(results[0].path);
        expect(basename(results[0].path)).not.toContain("..");
    });

    test("refuses a file:// media url instead of copying a local file into the output", async () => {
        // Bun's fetch resolves file:// and answers 200 with the contents, so an
        // unvalidated media url out of Instagram's JSON is a local-file read.
        let requested = 0;
        globalThis.fetch = mock(async () => {
            requested += 1;
            return new Response("secret", { status: 200 });
        }) as unknown as typeof fetch;
        const dir = await scratchDir();

        const failure = await downloadReels(
            [reelWith(storyItem({ mediaUrl: "file:///etc/hosts" }), "someone")],
            dir
        ).catch((error) => error);

        expect(requested).toBe(0);
        expect(failure).toBeInstanceOf(Error);
    });

    test("keeps going past one failed item and reports the survivor", async () => {
        // The mixed path: neither all-success nor all-failure, and the only one
        // where a short download could be mistaken for a complete one.
        let call = 0;
        globalThis.fetch = mock(async () => {
            call += 1;
            return call === 1
                ? new Response("nope", { status: 404 })
                : new Response(new Uint8Array([9, 9]), { status: 200 });
        }) as unknown as typeof fetch;
        const dir = await scratchDir();

        const reel: StoryReel = {
            reelId: "123",
            ownerUsername: "someone",
            items: [storyItem({ id: "gone" }), storyItem({ id: "kept" })],
        };
        const results = await downloadReels([reel], dir);

        expect(results).toHaveLength(1);
        expect(results[0].item.id).toBe("kept");
        expect(summarizeDownloads([reel], results)).toEqual({ requested: 2, downloaded: 1, failed: 1 });
    });

    test("reports every-download-failed rather than returning an empty success", async () => {
        globalThis.fetch = mock(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
        const dir = await scratchDir();

        const failure = await downloadReels([reelWith(storyItem(), "someone")], dir).catch((error) => error);

        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain("failed");
    });
});
