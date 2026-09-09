import { describe, expect, test } from "bun:test";
import { Browser } from "@genesiscz/utils/browser";
import { copyToClipboard, readFromClipboard } from "@genesiscz/utils/clipboard";
import { escapeJxa, runJxa } from "@genesiscz/utils/macos/jxa";
import { NotificationBackend, sendNotification } from "@genesiscz/utils/macos/notifications";
import {
    dispatchNotification,
    dispatchSay,
    dispatchSystem,
    dispatchTelegram,
    dispatchWebhook,
    notificationsConfig,
} from "@genesiscz/utils/notifications";
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
        test("Browser.open throws instead of opening a tab", () => {
            expect(() => Browser.open("https://example.com")).toThrow(/Browser\.open is blocked under bun test/);
        });

        test("Browser.openAll throws instead of opening tabs", () => {
            expect(() => Browser.openAll(["https://example.com"])).toThrow(/Browser\.openAll is blocked/);
        });

        test("the message names the surface, the remedy and the opt-out", () => {
            expect(() => Browser.open("https://example.com")).toThrow(/Inject the opener/);
            expect(() => Browser.open("https://example.com")).toThrow(/RUN_HOST_EFFECTS=1/);
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

        test("sendNotification throws instead of raising a banner", () => {
            expect(() => sendNotification({ message: "hi" })).toThrow(/sendNotification is blocked/);
        });

        test("NEGATIVE CONTROL: the notification backends are still exported", () => {
            expect(String(NotificationBackend.Osascript)).toBe("osascript");
        });
    });

    describe("notification channels", () => {
        const event = { app: "test", message: "hi" };

        test("dispatchNotification throws instead of delivering", () => {
            expect(() => dispatchNotification(event)).toThrow(/dispatchNotification is blocked/);
        });

        test("dispatchSay throws instead of speaking", () => {
            expect(() => dispatchSay("hi", { enabled: true })).toThrow(/dispatchSay is blocked/);
        });

        test("dispatchTelegram throws instead of posting to a real chat", () => {
            expect(() => dispatchTelegram(event, { enabled: true })).toThrow(/dispatchTelegram is blocked/);
        });

        test("dispatchWebhook throws instead of posting to a real endpoint", () => {
            expect(() => dispatchWebhook(event, { enabled: true, url: "https://a.dev/h" })).toThrow(
                /dispatchWebhook is blocked/
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

        test("dispatchSystem throws instead of raising a real notification", () => {
            expect(() => dispatchSystem(event, { enabled: true })).toThrow(/dispatchSystem is blocked/);
        });

        test("NEGATIVE CONTROL: the notifications config is still exported", () => {
            expect(notificationsConfig).toBeDefined();
        });
    });
});
