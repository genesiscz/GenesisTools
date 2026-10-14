import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, DEFAULT_YOUTUBE_CONFIG, YoutubeConfig } from "@app/youtube/lib/config";
import { SafeJSON } from "@genesiscz/utils/json";

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

        expect(await cfg.get("apiPort")).toBe(9886);
        expect(await cfg.get("apiBaseUrl")).toBe("http://localhost:9886");
        expect(await cfg.get("firstRunComplete")).toBe(false);
        expect(await cfg.get("preferredLangs")).toEqual(["en"]);
    });

    it("reads the old default port (Blender MCP's 9876) as the new one, but keeps a chosen port", async () => {
        await Bun.write(
            join(baseDir, CONFIG_FILENAME),
            SafeJSON.stringify({ apiPort: 9876, apiBaseUrl: "http://127.0.0.1:9876" }, { strict: true })
        );
        const legacy = new YoutubeConfig({ baseDir });

        expect(await legacy.get("apiPort")).toBe(9886);
        expect(await legacy.get("apiBaseUrl")).toBe("http://localhost:9886");

        await Bun.write(
            join(baseDir, CONFIG_FILENAME),
            SafeJSON.stringify({ apiPort: 9999, apiBaseUrl: "http://127.0.0.1:9999" }, { strict: true })
        );
        const chosen = new YoutubeConfig({ baseDir });

        expect(await chosen.get("apiPort")).toBe(9999);
        expect(await chosen.get("apiBaseUrl")).toBe("http://127.0.0.1:9999");
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

    it("keeps pollMs 0 and replaces invalid worker timer fields with defaults", async () => {
        const cfg = new YoutubeConfig({ baseDir });
        await cfg.update({ workers: { pollMs: 0 } });
        expect((await cfg.get("workers")).pollMs).toBe(0);

        await Bun.write(
            cfg.where(),
            `${SafeJSON.stringify(
                { workers: { pollMs: "fast", idleTeardownMs: 0, max: -1, spawnPolicy: "turbo" } },
                { strict: true }
            )}\n`
        );
        const fresh = new YoutubeConfig({ baseDir });
        expect(await fresh.get("workers")).toEqual(DEFAULT_YOUTUBE_CONFIG.workers);
    });

    it.each([
        { ai: { saved: "first" } },
        { provider: ["saved"] },
        { workers: "saved" },
        { workers: { max: -1 } },
        { workers: { max: 1.5 } },
        { workers: { pollMs: "fast" } },
        { workers: { idleTeardownMs: 0 } },
        { workers: { spawnPolicy: "turbo" } },
        { workers: { custom: "keep me" } },
        { referrals: { offers: null } },
    ])("refuses an update that would normalize away stored values", async (malformed) => {
        const cfg = new YoutubeConfig({ baseDir });
        const before = `${SafeJSON.stringify(malformed, { strict: true }, 2)}\n`;
        await Bun.write(cfg.where(), before);
        // Tolerant request-time reads remain available, and a cached read cannot bypass the disk guard.
        const displayed = await cfg.getAll();

        await expect(cfg.update({ firstRunComplete: true })).rejects.toThrow("refusing to replace");

        expect(await readFile(cfg.where(), "utf8")).toBe(before);
        expect(await cfg.getAll()).toEqual(displayed);
    });

    it.each(["null", "[]", '"saved"', "3", '{"ai":'])(
        "refuses invalid top-level data or a parse failure",
        async (before) => {
            const cfg = new YoutubeConfig({ baseDir });
            await Bun.write(cfg.where(), before);

            await expect(cfg.update({ keepVideo: true })).rejects.toThrow();

            expect(await readFile(cfg.where(), "utf8")).toBe(before);
        }
    );

    it("updates valid partial config and still migrates the retired default port", async () => {
        const cfg = new YoutubeConfig({ baseDir });
        await Bun.write(
            cfg.where(),
            SafeJSON.stringify({ apiPort: 9876, workers: { pollMs: 0 }, provider: { qa: "local" } })
        );

        await cfg.update({ firstRunComplete: true });

        const persisted = await new YoutubeConfig({ baseDir }).getAll();
        expect(persisted.apiPort).toBe(DEFAULT_YOUTUBE_CONFIG.apiPort);
        expect(persisted.workers.pollMs).toBe(0);
        expect(persisted.provider.qa).toBe("local");
        expect(persisted.firstRunComplete).toBe(true);
    });

    it("reset() persists defaults", async () => {
        const cfg = new YoutubeConfig({ baseDir });
        await cfg.set("apiPort", 12345);
        await cfg.reset();
        const file = await readFile(cfg.where(), "utf8");

        expect(await cfg.get("apiPort")).toBe(DEFAULT_YOUTUBE_CONFIG.apiPort);
        expect(file).toContain(`"apiPort": ${DEFAULT_YOUTUBE_CONFIG.apiPort}`);
    });
});
