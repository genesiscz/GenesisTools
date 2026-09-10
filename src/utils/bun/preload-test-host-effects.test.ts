import { describe, expect, test } from "bun:test";
import { Browser } from "@genesiscz/utils/browser";
import { copyToClipboard, readFromClipboard } from "@genesiscz/utils/clipboard";
import { fullDiskAccessSubject, requestFullDiskAccess } from "@genesiscz/utils/macos/full-disk-access";
import { escapeJxa, runJxa } from "@genesiscz/utils/macos/jxa";
import { NotificationBackend, sendNotification } from "@genesiscz/utils/macos/notifications";
import { settings } from "@genesiscz/utils/macos/system-settings";
import {
    dispatchNotification,
    dispatchSay,
    dispatchSystem,
    dispatchTelegram,
    dispatchWebhook,
    notificationsConfig,
} from "@genesiscz/utils/notifications";
import {
    buildEmptyScript,
    buildMoveScript,
    emptyTrash,
    stageAndConfirm,
    stageItems,
} from "@genesiscz/utils/prompts/clack/trash-staging";
import { skip } from "@genesiscz/utils/test/skip";

/**
 * Guards the host-effect preload itself. If any of these fail, tests can reach
 * the machine the user is sitting at: open browser tabs, overwrite the
 * clipboard, drive Notes through osascript, or post to a real Telegram chat.
 *
 * The preload cannot be imported here — it is a `[test] preload`, it runs
 * before any test module loads, and importing it again would install a second
 * set of mocks over the first. So these assert the INVARIANTS it maintains,
 * from inside a process it has already configured. Same shape as
 * preload-test-sandbox.test.ts.
 *
 * Half of these are NEGATIVE CONTROLS. Each guard replaces one export inside a
 * module it must otherwise leave alone, and a blanket mock that swallowed the
 * rest of the module would look exactly as green as a correct one.
 */
describe("host-effect preload", () => {
    describe("browser", () => {
        // `.rejects`, not `.toThrow`: the real `Browser.open` is async, and a
        // guard that threw synchronously would change the shape of every
        // fire-and-forget call site it stands in for.
        test("Browser.open rejects instead of opening a tab", async () => {
            await expect(Browser.open("https://example.com")).rejects.toThrow(
                /Browser\.open is blocked under bun test/
            );
        });

        test("Browser.openAll rejects instead of opening tabs", async () => {
            await expect(Browser.openAll(["https://example.com"])).rejects.toThrow(/Browser\.openAll is blocked/);
        });

        test("the message names the surface, the remedy and the opt-out", async () => {
            await expect(Browser.open("https://example.com")).rejects.toThrow(/Inject the opener/);
            await expect(Browser.open("https://example.com")).rejects.toThrow(/RUN_HOST_EFFECTS=1/);
        });

        test("NEGATIVE CONTROL: the rest of the browser module survives", () => {
            expect(Browser.SUPPORTED).toContain("brave");
            expect(typeof Browser.getPreferred).toBe("function");
            expect(typeof Browser.setPreferred).toBe("function");
        });
    });

    describe("clipboard", () => {
        test("a copy round-trips through the in-memory fake", async () => {
            await copyToClipboard("first value", { silent: true });
            expect(await readFromClipboard()).toBe("first value");

            await copyToClipboard("second value", { silent: true });
            expect(await readFromClipboard()).toBe("second value");
        });

        test.skipIf(skip.unlessMac)("the real system clipboard is never written", async () => {
            const sentinel = `genesis-tools-host-effect-${Date.now()}`;
            await copyToClipboard(sentinel, { silent: true });

            const proc = Bun.spawn(["pbpaste"], { stdout: "pipe", stderr: "ignore", env: process.env });
            const real = await new Response(proc.stdout).text();

            // Compared as a boolean on purpose: a failing `toBe` would print the
            // user's actual clipboard contents into the test log.
            expect(real === sentinel).toBe(false);
            expect(await readFromClipboard()).toBe(sentinel);
        });
    });

    describe("macOS automation", () => {
        test("runJxa throws instead of driving a real application", () => {
            expect(() => runJxa("Application('Notes').notes()")).toThrow(/runJxa is blocked under bun test/);
        });

        test("NEGATIVE CONTROL: escapeJxa still does its real work", () => {
            expect(escapeJxa('a "quoted" value')).toContain('\\"');
        });

        test("sendNotification rejects instead of raising a banner", async () => {
            await expect(sendNotification({ message: "hi" })).rejects.toThrow(/sendNotification is blocked/);
        });

        test("NEGATIVE CONTROL: the notification backends are still exported", () => {
            expect(String(NotificationBackend.Osascript)).toBe("osascript");
        });

        test("every System Settings pane throws instead of raising a window", () => {
            for (const pane of Object.keys(settings)) {
                const open = Reflect.get(settings, pane);
                expect(open).toBeInstanceOf(Function);
                expect(() => (open as () => void)()).toThrow(/MacOS\.settings\..+ is blocked/);
            }
        });

        test("requestFullDiskAccess throws instead of hanging on a modal dialog", () => {
            expect(() => requestFullDiskAccess({ reason: "read a fixture" })).toThrow(
                /requestFullDiskAccess is blocked/
            );
        });

        test("NEGATIVE CONTROL: the full-disk-access message builders still work", () => {
            expect(fullDiskAccessSubject()).toBeTruthy();
        });
    });

    describe("the Trash", () => {
        test("emptyTrash rejects instead of emptying the user's Trash", async () => {
            await expect(emptyTrash()).rejects.toThrow(/emptyTrash is blocked/);
        });

        test("stageItems rejects instead of moving real files", async () => {
            await expect(stageItems([{ id: "one", path: "/tmp/nope", bytes: 1 }])).rejects.toThrow(
                /stageItems is blocked/
            );
        });

        test("stageAndConfirm rejects instead of moving and prompting", async () => {
            await expect(stageAndConfirm({ items: [{ id: "one", path: "/tmp/nope", bytes: 1 }] })).rejects.toThrow(
                /stageAndConfirm is blocked/
            );
        });

        test("NEGATIVE CONTROL: the pure script builders are untouched", () => {
            expect(buildEmptyScript()).toBe('tell application "Finder" to empty trash');
            expect(buildMoveScript("/tmp/x.dmg")).toContain("/tmp/x.dmg");
        });
    });

    describe("notification channels", () => {
        const event = { app: "test", message: "hi" };

        test("dispatchNotification rejects instead of delivering", async () => {
            await expect(dispatchNotification(event)).rejects.toThrow(/dispatchNotification is blocked/);
        });

        test("dispatchSay rejects instead of speaking", async () => {
            await expect(dispatchSay("hi", { enabled: true })).rejects.toThrow(/dispatchSay is blocked/);
        });

        test("dispatchTelegram rejects instead of posting to a real chat", async () => {
            await expect(dispatchTelegram(event, { enabled: true })).rejects.toThrow(/dispatchTelegram is blocked/);
        });

        test("dispatchWebhook rejects instead of posting to a real endpoint", async () => {
            await expect(dispatchWebhook(event, { enabled: true, url: "https://a.dev/h" })).rejects.toThrow(
                /dispatchWebhook is blocked/
            );
        });

        test("NEGATIVE CONTROL: both loopback spellings pass through to the real dispatcher", async () => {
            // Nothing listens on port 9 of an assigned loopback address, so the
            // real dispatcher answers false immediately. That it answered at
            // all is the point: it was not refused, and no packet left the
            // machine either way. `127.0.0.1` goes through the 127.0.0.0/8
            // pattern and `localhost` through the name branch, so one test
            // covers both halves of the check.
            await expect(dispatchWebhook(event, { enabled: true, url: "http://127.0.0.1:9/hook" })).resolves.toBe(
                false
            );
            await expect(dispatchWebhook(event, { enabled: true, url: "http://localhost:9/hook" })).resolves.toBe(
                false
            );
        });

        test("NEGATIVE CONTROL: dispatchWebhook still reaches a server the test started itself", async () => {
            let received = 0;
            const server = Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch: () => {
                    received += 1;
                    return new Response("ok");
                },
            });

            try {
                const url = `http://127.0.0.1:${server.port}/hook`;
                await expect(dispatchWebhook(event, { enabled: true, url })).resolves.toBe(true);
                expect(received).toBe(1);
            } finally {
                await server.stop();
            }
        });

        test("NEGATIVE CONTROL: a disabled webhook is the real no-op, not a refusal", async () => {
            await expect(dispatchWebhook(event, { enabled: false, url: "https://a.dev/h" })).resolves.toBe(true);
        });

        test("dispatchSystem rejects instead of raising a real notification", async () => {
            await expect(dispatchSystem(event, { enabled: true })).rejects.toThrow(/dispatchSystem is blocked/);
        });

        test("NEGATIVE CONTROL: the notifications config is still exported", () => {
            expect(notificationsConfig).toBeDefined();
        });
    });
});
