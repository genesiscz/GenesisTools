import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { DEFAULT_CACHE_DIR } from "@app/youtube/lib/cache";
import { DEFAULT_BASE_DIR } from "@app/youtube/lib/config";
import { DEFAULT_DB_PATH } from "@app/youtube/lib/db";
import { SERVER_BASE_DIR } from "@app/youtube/lib/server/port-file";
import { env } from "@genesiscz/utils/env";

/**
 * These four constants used to be built from `homedir()` directly, which walked
 * straight past the `[test] preload` sandbox. Nothing failed, because every
 * youtube test happened to pass an explicit `:memory:` db and a tmpdir baseDir —
 * so the real 7.5 MB library was one forgetful `new YoutubeDatabase()` away from
 * being written by the suite.
 */
describe("youtube default paths", () => {
    const sandboxHome = env.tools.getHome();
    // biome-ignore lint/plugin: asserts against the REAL home on purpose — the whole point is that the sandbox is elsewhere
    const realPrefix = `${homedir()}/.genesis-tools`;

    it("resolves under GENESIS_TOOLS_HOME, not the real home", () => {
        expect(sandboxHome).not.toBe(homedir());

        for (const path of [DEFAULT_BASE_DIR, DEFAULT_DB_PATH, DEFAULT_CACHE_DIR, SERVER_BASE_DIR]) {
            expect(path.startsWith(sandboxHome)).toBe(true);
            expect(path.startsWith(realPrefix)).toBe(false);
        }
    });
});
