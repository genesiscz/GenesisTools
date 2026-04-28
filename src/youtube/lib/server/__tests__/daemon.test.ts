import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPid, readPid, writePid } from "@app/youtube/lib/server/daemon";
import { generateLaunchdPlist } from "@app/youtube/lib/server/launchd";

describe("server daemon helpers", () => {
    it("writes, reads, and clears a live process pid", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-daemon-"));
        const pidFile = join(dir, "server.pid");

        try {
            expect(readPid({ pidFile })).toBeNull();

            writePid({ pid: process.pid, pidFile });

            expect(readPid({ pidFile })).toBe(process.pid);

            clearPid({ pidFile });

            expect(readPid({ pidFile })).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("treats stale and invalid pid files as not running", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-server-daemon-"));
        const pidFile = join(dir, "server.pid");

        try {
            await Bun.write(pidFile, "not-a-pid");
            expect(readPid({ pidFile })).toBeNull();

            await Bun.write(pidFile, "99999999");
            expect(readPid({ pidFile })).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("generates a launchd plist for the configured server command", () => {
        const plist = generateLaunchdPlist({
            port: 9877,
            bunPath: "/usr/local/bin/bun",
            entryPath: "/repo/src/youtube/lib/server/index.ts",
        });

        expect(plist).toContain("com.genesis-tools.youtube-server");
        expect(plist).toContain("/usr/local/bin/bun");
        expect(plist).toContain("/repo/src/youtube/lib/server/index.ts");
        expect(plist).toContain("<string>9877</string>");
    });
});
