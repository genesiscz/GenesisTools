import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Browser } from "@genesiscz/utils/browser";
import { copyToClipboard, readFromClipboard } from "@genesiscz/utils/clipboard";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { fullDiskAccessSubject, requestFullDiskAccess } from "@genesiscz/utils/macos/full-disk-access";
import { genesisAppRpc, genesisAppRpcSync } from "@genesiscz/utils/macos/genesis-app-rpc";
import { escapeJxa, runJxa } from "@genesiscz/utils/macos/jxa";
import { NotificationBackend, postNotification, sendNotification } from "@genesiscz/utils/macos/notifications";
import { appNotificationBackend, authorizeNotifications } from "@genesiscz/utils/macos/notifications-app";
import { settings } from "@genesiscz/utils/macos/system-settings";
import {
    CHANNELS,
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
import { hostEffectRefusal, TEST_RUNTIME_FLAG } from "@genesiscz/utils/test-process";

/**
 * Guards the machine the user is sitting at from `bun test`, in two layers:
 *
 * - the in-code refusal at each surface's own entry (`hostEffectRefusal`), which also holds in a `tools` child a
 *   test spawns, because the child inherits the test signals;
 * - the preload, which still covers the two surfaces that cannot refuse by themselves (the clipboard package and the
 *   Finder Trash staging). It cannot be imported here: it runs before any test module loads, and importing it again
 *   would install a second set of mocks over the first.
 *
 * Every surface test is built so that a missing refusal fails harmlessly where it can: spawns by name run with an
 * empty PATH, and the Full Disk Access dialog sits behind a fresh throttle stamp.
 *
 * Half of these are NEGATIVE CONTROLS: a refusal must leave the rest of its module alone, and a blanket refusal would
 * look exactly as green as a correct one.
 */

const REFUSED = /is refused in a test process/;

/** A folder with no executables, so a spawn by name cannot start a real opener if a refusal were missing. */
const emptyBin = (): string => mkdtempSync(join(tmpdir(), "host-effects-empty-bin-"));

/** A stamp dir whose throttle stamp is fresh, so a missing refusal returns "throttled" instead of raising a dialog. */
function freshFdaStamp(): string {
    const dir = mkdtempSync(join(tmpdir(), "host-effects-fda-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fda-prompted-at"), String(Date.now()));
    return dir;
}

function withEmptyPath(fn: () => void | Promise<void>): Promise<void> {
    return env.testing.withOverrides({ PATH: emptyBin() }, fn);
}

describe("host-effect refusals at each surface's entry", () => {
    describe("browser", () => {
        test("Browser.open rejects instead of opening a tab, naming the remedy and the opt-out", async () => {
            await withEmptyPath(async () => {
                const open = Browser.open("https://example.invalid/c41");
                await expect(open).rejects.toThrow(/Browser\.open is refused in a test process/);
                await expect(Browser.open("https://example.invalid/c41")).rejects.toThrow(/Inject the opener/);
                await expect(Browser.open("https://example.invalid/c41")).rejects.toThrow(/RUN_HOST_EFFECTS=1/);
            });
        });

        test("Browser.openAll rejects through the same entry", async () => {
            await withEmptyPath(async () => {
                await expect(Browser.openAll(["https://example.invalid/c41"])).rejects.toThrow(REFUSED);
            });
        });

        test("NEGATIVE CONTROL: the rest of the browser module survives", () => {
            expect(Browser.SUPPORTED).toContain("brave");
            expect(typeof Browser.getPreferred).toBe("function");
            expect(typeof Browser.setPreferred).toBe("function");
        });
    });

    describe("macOS automation", () => {
        test("runJxa throws instead of driving a real application", async () => {
            await withEmptyPath(() => {
                expect(() => runJxa("Application('Notes').notes()")).toThrow(/runJxa is refused in a test process/);
                expect(() => runJxa("Application('Notes').notes()")).toThrow(/Fake the script result/);
            });
        });

        test("NEGATIVE CONTROL: escapeJxa still does its real work", () => {
            expect(escapeJxa('a "quoted" value')).toContain('\\"');
        });

        test("every System Settings pane throws instead of raising a window", async () => {
            await withEmptyPath(() => {
                for (const pane of Object.keys(settings)) {
                    const open = Reflect.get(settings, pane);
                    expect(open).toBeInstanceOf(Function);
                    expect(() => (open as () => void)()).toThrow(/System Settings pane .+ is refused/);
                    expect(() => (open as () => void)()).toThrow(/Assert that the pane would be opened/);
                }
            });
        });

        test("requestFullDiskAccess throws instead of raising a modal dialog", () => {
            const options = { reason: "read a fixture", stampDir: freshFdaStamp() };

            expect(() => requestFullDiskAccess(options)).toThrow(/requestFullDiskAccess is refused in a test process/);
            expect(() => requestFullDiskAccess(options)).toThrow(/nobody is there to answer/);
        });

        test("NEGATIVE CONTROL: the full-disk-access message builders still work", () => {
            expect(fullDiskAccessSubject()).toBeTruthy();
        });
    });

    describe("notifications and the app", () => {
        test("postNotification rejects instead of raising a banner through any backend", async () => {
            await withEmptyPath(async () => {
                await expect(postNotification({ message: "hi" })).rejects.toThrow(/postNotification is refused/);
                await expect(sendNotification({ message: "hi" })).rejects.toThrow(/Assert the notification payload/);
            });
        });

        test("the app RPC answers a refused outcome instead of spawning the signed app", async () => {
            const outcome = await genesisAppRpc("notify.post", { message: "hi" });
            const sync = genesisAppRpcSync("rpc.hello");

            for (const answer of [outcome, sync]) {
                expect(answer.ok).toBe(false);
                expect(!answer.ok && answer.error.code).toBe("refused_in_test");
                expect(!answer.ok && answer.error.message).toMatch(/GenesisTools\.app RPC .+ is refused/);
                expect(!answer.ok && answer.error.message).toMatch(/Assert the request/);
            }
        });

        test("what reaches the app through the RPC gets that refusal, not a spawn", async () => {
            await expect(appNotificationBackend.send({ message: "hi" })).resolves.toBe(null);
            const authorized = await authorizeNotifications();
            expect(!authorized.ok && authorized.error.code).toBe("refused_in_test");
            expect(typeof appNotificationBackend.terminalNotifierFixHint).toBe("function");
        });

        test("NEGATIVE CONTROL: the notification backends are still exported", () => {
            expect(String(NotificationBackend.Osascript)).toBe("osascript");
        });
    });

    describe("notification channels", () => {
        const event = { app: "test", message: "hi" };

        test("the say channel rejects instead of speaking", async () => {
            await expect(dispatchSay("hi", { enabled: true })).rejects.toThrow(/say notification channel is refused/);
            await expect(CHANNELS.say.post(event, { enabled: true })).rejects.toThrow(/speaking it out loud/);
        });

        test("the Telegram channel rejects instead of posting to a real chat", async () => {
            const config = { enabled: true, botToken: "123:fake", chatId: "42" };

            await expect(dispatchTelegram(event, config)).rejects.toThrow(/Telegram notification channel is refused/);
            await expect(CHANNELS.telegram.post(event, config)).rejects.toThrow(/posting it to a real chat/);
        });

        test("the webhook channel rejects a non-loopback URL", async () => {
            const config = { enabled: true, url: "https://a.dev/h" };

            await expect(dispatchWebhook(event, config)).rejects.toThrow(/webhook notification channel is refused/);
            await expect(CHANNELS.webhook.post(event, config)).rejects.toThrow(/loopback server the test starts/);
        });

        test.skipIf(skip.unlessMac)("the system channel rejects instead of raising a real notification", async () => {
            await withEmptyPath(async () => {
                await expect(dispatchSystem(event, { enabled: true })).rejects.toThrow(
                    /system notification channel is refused/
                );
                await expect(CHANNELS.system.post(event, { enabled: true })).rejects.toThrow(/real notification/);
            });
        });

        test("dispatchNotification never rejects: a refused channel is a failed one", async () => {
            await withEmptyPath(async () => {
                await expect(dispatchNotification(event)).resolves.toBeTypeOf("boolean");
            });
        });

        test("NEGATIVE CONTROL: both loopback spellings pass through to the real dispatcher", async () => {
            // Nothing listens on port 9 of an assigned loopback address, so the real dispatcher answers false
            // immediately. That it answered at all is the point: it was not refused, and no packet left the machine.
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

        test("NEGATIVE CONTROL: a disabled channel is the real no-op, not a refusal", async () => {
            await expect(dispatchWebhook(event, { enabled: false, url: "https://a.dev/h" })).resolves.toBe(true);
            await expect(dispatchTelegram(event, { enabled: false })).resolves.toBe(true);
            await expect(dispatchSay("hi", { enabled: false })).resolves.toBe(true);
        });

        test("NEGATIVE CONTROL: the notifications config is still exported", () => {
            expect(notificationsConfig).toBeDefined();
        });
    });

    describe("the test signal needs two signals, never one variable", () => {
        // `Bun.main` is this test file here, so each verdict is asked with a production entrypoint in its place.
        const worker = "/srv/app/worker.ts";

        test("NEGATIVE: the leaked preload flag alone does not refuse (the tmux incidents)", async () => {
            await env.testing.withOverrides({ NODE_ENV: "production", [TEST_RUNTIME_FLAG]: "1" }, () => {
                expect(hostEffectRefusal("Browser.open", "remedy", worker)).toBe(null);
            });
        });

        test("NEGATIVE: NODE_ENV=test alone does not refuse", async () => {
            await env.testing.withOverrides({ NODE_ENV: "test", [TEST_RUNTIME_FLAG]: undefined }, () => {
                expect(hostEffectRefusal("Browser.open", "remedy", worker)).toBe(null);
            });
        });

        test("a child a test spawns (the flag and NODE_ENV=test) is refused", async () => {
            await env.testing.withOverrides({ NODE_ENV: "test", [TEST_RUNTIME_FLAG]: "1" }, () => {
                expect(hostEffectRefusal("Browser.open", "remedy", worker)).toMatch(/NODE_ENV=test, .+ remedy/);
            });
        });

        test("RUN_HOST_EFFECTS=1 lifts the refusal for a deliberate end-to-end check", async () => {
            await env.testing.withOverrides({ RUN_HOST_EFFECTS: "1" }, () => {
                expect(hostEffectRefusal("Browser.open", "remedy")).toBe(null);
            });
        });
    });

    describe("a child process a test spawns", () => {
        // The repo root, so the child imports this checkout's modules by absolute path.
        const root = resolve(import.meta.dir, "../../..");

        /** Runs `code` in a plain `bun -e` child (no test preload) with an empty PATH and the given test signals. */
        async function runChild(code: string, signals: Record<string, string | undefined>): Promise<string> {
            const childEnv: Record<string, string | undefined> = { ...process.env, PATH: emptyBin(), ...signals };
            const proc = Bun.spawn([process.execPath, "-e", code], {
                cwd: root,
                env: childEnv,
                stdout: "pipe",
                stderr: "pipe",
            });
            const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
            await proc.exited;
            return `${out}${err}`;
        }

        test("a spawned command that would open a URL is refused in the child", async () => {
            const code = `
                const { Browser } = await import(${SafeJSON.stringify(join(root, "src/utils/browser.ts"))});
                try {
                    const result = await Browser.open("https://example.invalid/c41-child");
                    console.log("OPENED " + JSON.stringify(result));
                } catch (error) {
                    console.log("REFUSED " + error.message);
                }
            `;
            const output = await runChild(code, { NODE_ENV: "test", [TEST_RUNTIME_FLAG]: "1" });

            expect(output).toContain("REFUSED Browser.open is refused in a test process");
            expect(output).toContain("Inject the opener");
            expect(output).not.toContain("OPENED");
        });

        test("NEGATIVE: a child with only the leaked flag is not refused", async () => {
            const code = `
                const { requestFullDiskAccess } = await import(${SafeJSON.stringify(join(root, "src/utils/macos/full-disk-access.ts"))});
                try {
                    console.log("ANSWER " + requestFullDiskAccess({ reason: "child", stampDir: ${SafeJSON.stringify(freshFdaStamp())} }));
                } catch (error) {
                    console.log("REFUSED " + error.message);
                }
            `;
            const output = await runChild(code, { NODE_ENV: "production", [TEST_RUNTIME_FLAG]: "1" });

            // "throttled" on macOS (the fresh stamp stops the dialog), "no-ui" elsewhere: either way it ran.
            expect(output).toMatch(/ANSWER (throttled|no-ui)/);
            expect(output).not.toContain("REFUSED");
        });
    });
});

describe("host-effect preload (the surfaces that cannot refuse by themselves)", () => {
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
});
