import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemChannelDelivered } from "@genesiscz/utils/notifications/channels/system";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import * as notifications from "./notifications";
import { launchdSession, resolveNotificationFallbackState, sendViaTerminalNotifier } from "./notifications";

setupStorageSandbox();

function fakeNotifier(body: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "fake-terminal-notifier-")), "terminal-notifier");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
}

describe("sendViaTerminalNotifier", () => {
    // Regression test: #455 — terminal-notifier returning exit 3 ("Could not request
    // notification permission: Notifications are not allowed for this application") was
    // ignored; GenesisTools logged "Notification sent via terminal-notifier" and exited 0
    // even though nothing was shown.
    it("treats a non-zero exit as undelivered", async () => {
        const delivered = await sendViaTerminalNotifier(
            "/opt/homebrew/bin/terminal-notifier",
            { message: "hello" },
            {
                spawn: async () => ({
                    exitCode: 3,
                    stderr: "Could not request notification permission: Notifications are not allowed for this application\n",
                }),
            }
        );

        expect(delivered).toBe(false);
    });

    it("treats a zero exit as delivered", async () => {
        const delivered = await sendViaTerminalNotifier(
            "/opt/homebrew/bin/terminal-notifier",
            { message: "hello" },
            { spawn: async () => ({ exitCode: 0, stderr: "" }) }
        );

        expect(delivered).toBe(true);
    });

    it("treats a spawn failure as undelivered rather than throwing", async () => {
        const delivered = await sendViaTerminalNotifier(
            "/opt/homebrew/bin/terminal-notifier",
            { message: "hello" },
            {
                spawn: async () => {
                    throw new Error("ENOENT");
                },
            }
        );

        expect(delivered).toBe(false);
    });

    // Regression test: PR #457 review — the send now waits for terminal-notifier's exit, so one
    // that never exits held sendNotification forever and the osascript fallback never ran.
    it("gives up on a terminal-notifier that never exits, kills it, and reports undelivered", async () => {
        let killed = false;
        const delivered = await sendViaTerminalNotifier(
            "/opt/homebrew/bin/terminal-notifier",
            { message: "hello" },
            {
                timeoutMs: 20,
                spawn: (_args, signal) =>
                    new Promise(() => {
                        signal.addEventListener("abort", () => {
                            killed = true;
                        });
                    }),
            }
        );

        expect(delivered).toBe(false);
        expect(killed).toBe(true);
    });
});

// Regression test: #455 item 5 — `tools notify status` said only "unavailable" when
// GenesisTools.app was missing, even though terminal-notifier (or osascript) would still
// carry the next notification. The status should name which one.
describe("resolveNotificationFallbackState", () => {
    it("reports genesis-app when the launcher is installed", async () => {
        const state = await resolveNotificationFallbackState({
            isAppAvailable: () => true,
            locateTerminalNotifier: async () => "/opt/homebrew/bin/terminal-notifier",
        });

        expect(state).toEqual({ kind: "genesis-app" });
    });

    it("reports terminal-notifier with its path when the app is missing but the binary exists", async () => {
        const state = await resolveNotificationFallbackState({
            isAppAvailable: () => false,
            locateTerminalNotifier: async () => "/opt/homebrew/bin/terminal-notifier",
        });

        expect(state).toEqual({ kind: "terminal-notifier", path: "/opt/homebrew/bin/terminal-notifier" });
    });

    it("falls back to osascript-only when neither is available", async () => {
        const state = await resolveNotificationFallbackState({
            isAppAvailable: () => false,
            locateTerminalNotifier: async () => null,
        });

        expect(state).toEqual({ kind: "osascript-only" });
    });
});

describe("systemChannelDelivered", () => {
    // Regression test: #455 — `tools notify` exited 0 after an osascript hand-off that no backend confirmed.
    it("an unconfirmed hand-off is not delivered when the caller requires confirmation", () => {
        expect(systemChannelDelivered({ confirmed: false }, { requireConfirmed: true })).toBe(false);
    });

    it("an unconfirmed hand-off still counts for callers that do not require confirmation", () => {
        expect(systemChannelDelivered({ confirmed: false }, {})).toBe(true);
    });

    it("a confirmed delivery counts when the caller requires confirmation", () => {
        expect(systemChannelDelivered({ confirmed: true }, { requireConfirmed: true })).toBe(true);
    });
});
// Regression test: PR #457 review round 2 — every send rewrote the cached path to the notify
// config, so a config that could not be written broke a notifier that was already cached.
describe("resolveTerminalNotifier", () => {
    it("returns a valid cached path without searching or rewriting the config", async () => {
        let writes = 0;
        let searches = 0;
        const path = await notifications.resolveTerminalNotifier({
            readCache: async () => "/bin/sh",
            writeCache: async () => {
                writes++;
            },
            search: async () => {
                searches++;
                return null;
            },
        });

        expect(path).toBe("/bin/sh");
        expect(writes).toBe(0);
        expect(searches).toBe(0);
    });

    it("still returns a found notifier when caching its path fails", async () => {
        const path = await notifications.resolveTerminalNotifier({
            readCache: async () => undefined,
            writeCache: async () => {
                throw new Error("config locked");
            },
            search: async () => "/bin/sh",
        });

        expect(path).toBe("/bin/sh");
    });
});

// Regression test: PR #457 review round 2 — discovery awaited `<candidate> -help` with no
// deadline, so a hung binary left `tools notify status` and every fallback send stuck.
describe("probeTerminalNotifier", () => {
    it("treats a candidate that never answers -help as unavailable", async () => {
        const started = performance.now();
        const usable = await notifications.probeTerminalNotifier(fakeNotifier("exec sleep 30"), { timeoutMs: 200 });

        expect(usable).toBe(false);
        expect(performance.now() - started).toBeLessThan(5_000);
    });

    it("accepts a candidate that answers -help", async () => {
        expect(await notifications.probeTerminalNotifier(fakeNotifier("exit 0"), { timeoutMs: 2_000 })).toBe(true);
    });

    // Regression test: PR #457 review round 3 — boundedCommand reports a plain non-zero exit in
    // `status`, not `error`, and its watchdog turns an exec failure into exit 127, so a broken or
    // non-executable candidate passed the probe and beat a working one.
    it("rejects a candidate whose -help exits non-zero", async () => {
        expect(await notifications.probeTerminalNotifier(fakeNotifier("exit 3"), { timeoutMs: 2_000 })).toBe(false);
    });

    it("rejects a candidate that is not executable", async () => {
        const path = fakeNotifier("exit 0");
        chmodSync(path, 0o644);

        expect(await notifications.probeTerminalNotifier(path, { timeoutMs: 2_000 })).toBe(false);
    });
});

describe("launchdSession", () => {
    // Regression test: #455 — an SSH or background session can never show a notification or a
    // permission prompt; the user should be told so instead of only "not confirmed".
    it("reports no GUI session for the Background launchd session", () => {
        expect(launchdSession(() => "Background")).toEqual({ gui: false, manager: "Background" });
    });

    it("reports a GUI session for the Aqua login session", () => {
        expect(launchdSession(() => "Aqua")).toEqual({ gui: true, manager: "Aqua" });
    });

    it("claims nothing when the session cannot be read", () => {
        expect(launchdSession(() => null)).toEqual({ gui: true, manager: null });
    });
});
