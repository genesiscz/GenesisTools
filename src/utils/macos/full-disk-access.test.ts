import { describe, expect, it } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { buildFullDiskAccessMessage, FULL_DISK_ACCESS_FEATURES, fullDiskAccessInstructions } from "./full-disk-access";
import { GENESIS_APP_BUNDLE_ID } from "./genesis-app";

const underApp = { GENESIS_TOOLS_APP_BUNDLE_ID: GENESIS_APP_BUNDLE_ID };
const underTerminal = { GENESIS_TOOLS_APP_BUNDLE_ID: undefined, __CFBundleIdentifier: "com.example.terminal" };

describe("buildFullDiskAccessMessage", () => {
    it("leads with what the command could not do", async () => {
        await env.testing.withOverrides(underApp, () => {
            const message = buildFullDiskAccessMessage({
                reason: "read your iMessage and SMS history",
                feature: "messages",
            });
            expect(message.split("\n")[0]).toBe("GenesisTools could not read your iMessage and SMS history.");
        });
    });

    it("lists every capability the switch unlocks and marks the current one", async () => {
        await env.testing.withOverrides(underApp, () => {
            const message = buildFullDiskAccessMessage({ reason: "search your mail", feature: "mail" });

            for (const capability of FULL_DISK_ACCESS_FEATURES) {
                expect(message).toContain(capability.label);
                expect(message).toContain(capability.gain);
            }

            const marked = message.split("\n").filter((line) => line.includes("← what you just ran"));
            expect(marked).toHaveLength(1);
            expect(marked[0]).toContain("Mail");
            expect(marked[0].trimStart().startsWith("▸")).toBe(true);
        });
    });

    it("marks nothing when the caller names no feature", async () => {
        await env.testing.withOverrides(underApp, () => {
            const message = buildFullDiskAccessMessage({ reason: "reach Mail, Messages or Voice Memos" });
            expect(message).not.toContain("← what you just ran");
        });
    });

    it("says what the grant does NOT widen", async () => {
        await env.testing.withOverrides(underApp, () => {
            expect(buildFullDiskAccessMessage({ reason: "search your mail" })).toContain(
                "still only reads what a command you run asks for"
            );
        });
    });

    it("gives three numbered steps, and points a terminal-owned process at its own identity", async () => {
        await env.testing.withOverrides(underApp, () => {
            const message = buildFullDiskAccessMessage({ reason: "search your mail" });
            expect(message).toContain("1. Click Open Settings below.");
            expect(message).toContain("2. Finder selects GenesisTools.");
            expect(message).toContain("3. Switch it on, then run your command again.");
        });

        await env.testing.withOverrides(underTerminal, () => {
            const message = buildFullDiskAccessMessage({ reason: "search your mail" });
            expect(message).toContain("com.example.terminal");
            expect(message).not.toContain("Finder selects GenesisTools.");
        });
    });
});

describe("fullDiskAccessInstructions", () => {
    it("names the other capabilities the grant unlocks, never the current one twice", async () => {
        await env.testing.withOverrides(underApp, () => {
            const text = fullDiskAccessInstructions({ reason: "search your mail", feature: "mail" });
            expect(text).toContain("Full Disk Access is required to search your mail.");
            expect(text).toContain("Messages and Voice Memos");
            expect(text).not.toContain("Mail and Messages");
        });
    });

    it("tells a terminal-owned process to build the app first", async () => {
        await env.testing.withOverrides(underTerminal, () => {
            expect(fullDiskAccessInstructions({ reason: "search your mail" })).toContain(
                "tools macos permissions build"
            );
        });
    });
});
