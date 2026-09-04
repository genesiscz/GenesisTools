import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import {
    GENESIS_APP_BUNDLE_ID,
    genesisAppLauncher,
    launchdPlistNeedsGenesisApp,
    launchdProgramArgumentsXml,
    wrapWithGenesisApp,
} from "./genesis-app";

/** A fake home with a built launcher, so wrapWithGenesisApp() has something to prepend. */
function homeWithLauncher(): { home: string; launcher: string } {
    const home = mkdtempSync(join(tmpdir(), "gt-launchd-home-"));
    const dir = join(home, "Applications", "GenesisTools.app", "Contents", "MacOS");
    mkdirSync(dir, { recursive: true });
    const launcher = join(dir, "GenesisTools");
    writeFileSync(launcher, "");
    return { home, launcher };
}

const clean = { GENESIS_TOOLS_APP_BUNDLE_ID: undefined, GENESIS_TOOLS_NO_APP: undefined };

describe("launchdProgramArgumentsXml", () => {
    it("prepends the launcher when it exists and escapes XML", async () => {
        const { home, launcher } = homeWithLauncher();
        await env.testing.withOverrides({ ...clean, GENESIS_TOOLS_HOME: home }, () => {
            const xml = launchdProgramArgumentsXml(["/usr/bin/bun", "run", "/x/a&b.ts"]);
            expect(xml.split("\n")).toEqual([
                "  <array>",
                `    <string>${launcher}</string>`,
                "    <string>/usr/bin/bun</string>",
                "    <string>run</string>",
                "    <string>/x/a&amp;b.ts</string>",
                "  </array>",
            ]);
        });
    });

    it("emits the bare command when no launcher is installed", async () => {
        await env.testing.withOverrides({ ...clean, GENESIS_TOOLS_HOME: "/nonexistent" }, () => {
            expect(launchdProgramArgumentsXml(["/usr/bin/bun", "run", "x.ts"])).not.toContain(
                "GenesisTools.app/Contents/MacOS"
            );
        });
    });
});

describe("launchdPlistNeedsGenesisApp", () => {
    it("is true only for an existing plist that lacks the launcher while the launcher exists", async () => {
        const { home, launcher } = homeWithLauncher();
        const bare = join(home, "bare.plist");
        const wrapped = join(home, "wrapped.plist");
        writeFileSync(bare, "<string>/usr/bin/bun</string>");
        writeFileSync(wrapped, `<string>${launcher}</string><string>/usr/bin/bun</string>`);

        await env.testing.withOverrides({ ...clean, GENESIS_TOOLS_HOME: home }, () => {
            expect(launchdPlistNeedsGenesisApp(bare)).toBe(true);
            expect(launchdPlistNeedsGenesisApp(wrapped)).toBe(false);
            expect(launchdPlistNeedsGenesisApp(join(home, "missing.plist"))).toBe(false);
        });
    });

    it("never asks for a migration when the launcher is absent or switched off", async () => {
        const { home } = homeWithLauncher();
        const bare = join(home, "bare.plist");
        writeFileSync(bare, "<string>/usr/bin/bun</string>");

        await env.testing.withOverrides({ ...clean, GENESIS_TOOLS_HOME: "/nonexistent" }, () => {
            expect(launchdPlistNeedsGenesisApp(bare)).toBe(false);
        });
        await env.testing.withOverrides({ ...clean, GENESIS_TOOLS_HOME: home, GENESIS_TOOLS_NO_APP: "1" }, () => {
            expect(launchdPlistNeedsGenesisApp(bare)).toBe(false);
        });
    });
});

describe("writing a plist while running under the app", () => {
    // Regression: `tools` runs every command through the launcher, so the writer always saw
    // isRunningUnderGenesisApp() === true. Asking the spawn-time question there produced plists
    // with the bare command and made the migration detector answer "nothing to migrate", which
    // disabled the whole feature in real use while the tests (which never set the marker) passed.
    const underApp = { GENESIS_TOOLS_APP_BUNDLE_ID: GENESIS_APP_BUNDLE_ID, GENESIS_TOOLS_NO_APP: undefined };

    it("still puts the launcher into ProgramArguments", async () => {
        const { home, launcher } = homeWithLauncher();
        await env.testing.withOverrides({ ...underApp, GENESIS_TOOLS_HOME: home }, () => {
            expect(wrapWithGenesisApp(["/usr/bin/bun", "run", "x.ts"])[0]).toBe(launcher);
            expect(launchdProgramArgumentsXml(["/usr/bin/bun"])).toContain(launcher);
        });
    });

    it("still reports a bare plist as needing migration", async () => {
        const { home } = homeWithLauncher();
        const bare = join(home, "bare.plist");
        writeFileSync(bare, "<string>/usr/bin/bun</string>");
        await env.testing.withOverrides({ ...underApp, GENESIS_TOOLS_HOME: home }, () => {
            expect(launchdPlistNeedsGenesisApp(bare)).toBe(true);
        });
    });

    it("does not double-wrap a process this command spawns itself", async () => {
        const { home } = homeWithLauncher();
        await env.testing.withOverrides({ ...underApp, GENESIS_TOOLS_HOME: home }, () => {
            // The dispatcher question stays "no": the tree is already covered.
            expect(genesisAppLauncher()).toBeNull();
        });
    });
});
