import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, DEFAULT_YOUTUBE_CONFIG, YoutubeConfig } from "@app/youtube/lib/config";

let baseDir: string;

beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "yt-config-"));
});

afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
});

describe("YoutubeConfig", () => {
    it("returns defaults on first read", async () => {
        const cfg = new YoutubeConfig({ baseDir });

        expect(await cfg.get("apiPort")).toBe(9876);
        expect(await cfg.get("apiBaseUrl")).toBe("http://localhost:9876");
        expect(await cfg.get("firstRunComplete")).toBe(false);
        expect(await cfg.get("preferredLangs")).toEqual(["en"]);
    });

    it("uses server.json under the configured base directory", () => {
        const cfg = new YoutubeConfig({ baseDir });

        expect(cfg.where()).toBe(join(baseDir, CONFIG_FILENAME));
    });

    it("persists set() across instances", async () => {
        const cfg1 = new YoutubeConfig({ baseDir });
        await cfg1.set("apiPort", 12345);
        const cfg2 = new YoutubeConfig({ baseDir });

        expect(await cfg2.get("apiPort")).toBe(12345);
    });

    it("update() merges nested config objects deeply", async () => {
        const cfg = new YoutubeConfig({ baseDir });
        await cfg.update({ concurrency: { download: 8 }, provider: { summarize: "openai" } });
        const all = await cfg.getAll();

        expect(all.concurrency.download).toBe(8);
        expect(all.concurrency.summarize).toBe(DEFAULT_YOUTUBE_CONFIG.concurrency.summarize);
        expect(all.provider.summarize).toBe("openai");
        expect(all.provider.transcribe).toBeUndefined();
    });

    it("returns clones so callers cannot mutate the in-memory cache", async () => {
        const cfg = new YoutubeConfig({ baseDir });
        const all = await cfg.getAll();
        all.concurrency.download = 99;

        expect((await cfg.get("concurrency")).download).toBe(DEFAULT_YOUTUBE_CONFIG.concurrency.download);
    });

    it("reset() persists defaults", async () => {
        const cfg = new YoutubeConfig({ baseDir });
        await cfg.set("apiPort", 12345);
        await cfg.reset();
        const file = await readFile(cfg.where(), "utf8");

        expect(await cfg.get("apiPort")).toBe(DEFAULT_YOUTUBE_CONFIG.apiPort);
        expect(file).toContain('"apiPort": 9876');
    });
});
