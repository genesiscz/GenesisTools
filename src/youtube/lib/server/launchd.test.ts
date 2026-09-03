import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { generateLaunchdPlist } from "./launchd";

function homeWithLauncher(): { home: string; launcher: string } {
    const home = mkdtempSync(join(tmpdir(), "gt-yt-launchd-"));
    const dir = join(home, "Applications", "GenesisTools.app", "Contents", "MacOS");
    mkdirSync(dir, { recursive: true });
    const launcher = join(dir, "GenesisTools");
    writeFileSync(launcher, "");
    return { home, launcher };
}

const clean = { GENESIS_TOOLS_APP_BUNDLE_ID: undefined, GENESIS_TOOLS_NO_APP: undefined };

describe("standalone plist writers", () => {
    it("youtube-server puts the launcher first and keeps the bare command without it", async () => {
        const { home, launcher } = homeWithLauncher();
        const opts = { port: 3074, bunPath: "/usr/bin/bun", entryPath: "/x/index.ts" };

        await env.testing.withOverrides({ ...clean, GENESIS_TOOLS_HOME: home }, () => {
            const plist = generateLaunchdPlist(opts);
            expect(plist.indexOf(`<string>${launcher}</string>`)).toBeLessThan(
                plist.indexOf("<string>/usr/bin/bun</string>")
            );
            expect(plist).toContain("<string>--port</string>");
            expect(plist).toContain("<string>3074</string>");
        });
        await env.testing.withOverrides({ ...clean, GENESIS_TOOLS_HOME: "/nonexistent" }, () => {
            expect(generateLaunchdPlist(opts)).not.toContain("GenesisTools.app/Contents/MacOS");
        });
    });
});
