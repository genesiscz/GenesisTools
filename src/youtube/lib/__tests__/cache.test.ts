import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioPath, deleteIfExists, ensureBinaryDir, thumbPath, videoDir, videoFilePath } from "@app/youtube/lib/cache";
import type { CacheLayout } from "@app/youtube/lib/cache.types";

let baseDir: string;
let layout: CacheLayout;

beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "yt-cache-"));
    layout = { cacheDir: baseDir };
});

afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
});

describe("cache path helpers", () => {
    it("builds sanitized per-channel video directories", () => {
        expect(videoDir(layout, "@Some Channel!*" as `@${string}`, "abc123")).toBe(
            join(baseDir, "channels", "Some_Channel__", "videos", "abc123")
        );
    });

    it("builds audio, video, and thumbnail paths", () => {
        expect(audioPath(layout, "@mkbhd", "video123", "wav")).toBe(
            join(baseDir, "channels", "mkbhd", "videos", "video123", "audio", "video123.wav")
        );
        expect(videoFilePath(layout, "@mkbhd", "video123", "mp4")).toBe(
            join(baseDir, "channels", "mkbhd", "videos", "video123", "video", "video123.mp4")
        );
        expect(thumbPath(layout, "@mkbhd", "video123")).toBe(
            join(baseDir, "channels", "mkbhd", "videos", "video123", "thumbs", "video123.jpg")
        );
    });

    it("creates the parent directory for a binary path", () => {
        const path = audioPath(layout, "@mkbhd", "video123", "wav");
        ensureBinaryDir(path);

        expect(existsSync(join(baseDir, "channels", "mkbhd", "videos", "video123", "audio"))).toBe(true);
    });

    it("deletes existing files and ignores missing files", async () => {
        const path = audioPath(layout, "@mkbhd", "video123", "wav");
        ensureBinaryDir(path);
        await writeFile(path, "audio");

        await deleteIfExists(path);
        await deleteIfExists(path);

        expect(existsSync(path)).toBe(false);
    });
});
