import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import {
    describeResponsibleIdentity,
    GENESIS_APP_BUNDLE_ID,
    genesisAppLauncher,
    isRunningUnderGenesisApp,
    responsibleIdentity,
    wrapWithGenesisApp,
} from "./genesis-app";

describe("responsibleIdentity", () => {
    it("reports GenesisTools.app when the launcher marker is set", async () => {
        await env.testing.withOverrides({ GENESIS_TOOLS_APP_BUNDLE_ID: GENESIS_APP_BUNDLE_ID }, () => {
            expect(isRunningUnderGenesisApp()).toBe(true);
            expect(responsibleIdentity()).toEqual({ kind: "genesis-app", bundleId: GENESIS_APP_BUNDLE_ID });
            expect(describeResponsibleIdentity()).toContain("GenesisTools.app");
        });
    });

    it("falls back to the launching app's bundle id", async () => {
        await env.testing.withOverrides(
            { GENESIS_TOOLS_APP_BUNDLE_ID: undefined, __CFBundleIdentifier: "com.example.terminal" },
            () => {
                expect(responsibleIdentity()).toEqual({ kind: "host-app", bundleId: "com.example.terminal" });
                expect(describeResponsibleIdentity()).toContain("com.example.terminal");
            }
        );
    });

    it("says unknown without any bundle in the environment", async () => {
        await env.testing.withOverrides(
            { GENESIS_TOOLS_APP_BUNDLE_ID: undefined, __CFBundleIdentifier: undefined },
            () => {
                expect(responsibleIdentity()).toEqual({ kind: "unknown" });
            }
        );
    });
});

describe("genesisAppLauncher", () => {
    it("never wraps a process that already runs under GenesisTools.app", async () => {
        await env.testing.withOverrides({ GENESIS_TOOLS_APP_BUNDLE_ID: GENESIS_APP_BUNDLE_ID }, () => {
            expect(genesisAppLauncher()).toBeNull();
            expect(wrapWithGenesisApp(["bun", "x"])).toEqual(["bun", "x"]);
        });
    });

    it("honours GENESIS_TOOLS_NO_APP=1", async () => {
        await env.testing.withOverrides({ GENESIS_TOOLS_APP_BUNDLE_ID: undefined, GENESIS_TOOLS_NO_APP: "1" }, () => {
            expect(genesisAppLauncher()).toBeNull();
        });
    });

    it("honours the disabled marker written by the settings window", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-home-"));
        const launcher = join(home, "Applications", "GenesisTools.app", "Contents", "MacOS");
        mkdirSync(launcher, { recursive: true });
        writeFileSync(join(launcher, "GenesisTools"), "");
        mkdirSync(join(home, ".genesis-tools", "app"), { recursive: true });
        writeFileSync(join(home, ".genesis-tools", "app", "disabled"), "");
        await env.testing.withOverrides(
            { GENESIS_TOOLS_APP_BUNDLE_ID: undefined, GENESIS_TOOLS_NO_APP: undefined, GENESIS_TOOLS_HOME: home },
            () => {
                expect(genesisAppLauncher()).toBeNull();
            }
        );
    });

    it("returns null when no bundle is installed under GENESIS_TOOLS_HOME", async () => {
        await env.testing.withOverrides(
            {
                GENESIS_TOOLS_APP_BUNDLE_ID: undefined,
                GENESIS_TOOLS_NO_APP: undefined,
                GENESIS_TOOLS_HOME: "/nonexistent",
            },
            () => {
                expect(genesisAppLauncher()).toBeNull();
            }
        );
    });
});
