import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import WebSocket from "ws";
import { CodexAccountBinding } from "./account";
import { type AppServerProcess, spawnAppServer } from "./app-server-client";
import { buildAccountLaunchOptions } from "./launch-options";
import { CodexHomeBusyError, isHomeInitRace, openTerminalServer } from "./terminal-server";

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    AiConfigStore.invalidate();
});

const modes = ["fixture", "setup-failure", ...(env.getProcessEnv().RUN_INTEGRATION === "1" ? ["installed"] : [])];
test.each(modes)(
    "%s terminal endpoint authenticates before serving the native client and cleans up on close",
    async (mode) => {
        const home = mkdtempSync(join(tmpdir(), "gt-terminal-fixture-"));
        const authFile = join(home, "auth.json");
        const token = `e30.${Buffer.from(SafeJSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, email: "selected@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "workspace-a", chatgpt_plan_type: "plus" } })).toString("base64url")}.test`;
        writeFileSync(
            authFile,
            SafeJSON.stringify({
                tokens: { access_token: token, refresh_token: "never-refresh", account_id: "workspace-a" },
            })
        );
        const configDir = join(home, ".genesis-tools/ai");
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            join(configDir, "config.json"),
            SafeJSON.stringify({
                version: CONFIG_VERSION,
                accounts: [
                    {
                        id: "acc_a",
                        name: "work",
                        provider: "openai-sub",
                        enabled: true,
                        billing: { mode: "subscription" },
                        credentials: { authFile },
                        accountUuid: "workspace-a",
                        useEnvApiKey: false,
                    },
                ],
                defaults: {},
            })
        );
        env.testing.set("GENESIS_TOOLS_HOME", home);
        AiConfigStore.invalidate();
        const shared = join(home, "shared");
        mkdirSync(shared);
        const desktopAuth = '{"OPENAI_API_KEY":"fixture-desktop-api-key"}';
        writeFileSync(join(shared, "auth.json"), desktopAuth);
        const child =
            mode === "installed"
                ? spawnAppServer({
                      ...buildAccountLaunchOptions({ sharedHome: shared, accountName: "work", cwd: home }),
                      envOverrides: {
                          HTTP_PROXY: "http://127.0.0.1:9",
                          HTTPS_PROXY: "http://127.0.0.1:9",
                          ALL_PROXY: "http://127.0.0.1:9",
                          NO_PROXY: "localhost,127.0.0.1",
                      },
                  })
                : Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/terminal-app-server.ts")], {
                      env: process.env,
                      stdin: "pipe",
                      stdout: "pipe",
                      stderr: "pipe",
                  });
        const before = readFileSync(authFile, "utf8");
        if (mode === "setup-failure") {
            const outcome = await openTerminalServer({
                account: await CodexAccountBinding.create("work", { allowRefresh: true }),
                child,
                socketRoot: authFile,
            }).then(
                async (server) => {
                    await server.close();
                    return null;
                },
                (error) => error
            );
            expect(outcome).toBeInstanceOf(Error);
            const exit = await Promise.race([child.exited, Bun.sleep(1000).then(() => "still running")]);
            expect(typeof exit).toBe("number");
            return;
        }
        const server = await openTerminalServer({
            account: await CodexAccountBinding.create("work", { allowRefresh: true }),
            child,
        });
        try {
            const socket = new WebSocket(`ws+unix://${server.socketPath}:/`);
            expect(readFileSync(join(shared, "auth.json"), "utf8")).toBe(desktopAuth);
            const messages: Array<Record<string, unknown>> = [];
            const firstPeerIds: unknown[] = [];
            socket.onmessage = (event) => {
                const message: Record<string, unknown> = SafeJSON.parse(String(event.data), { strict: true });
                firstPeerIds.push(message.id);
                // Account/plugin notifications may interleave with the two RPC responses.
                if (message.id === 1 || message.id === 2) {
                    messages.push(message);
                }
            };
            await new Promise<void>((resolve, reject) => {
                socket.onopen = () => resolve();
                socket.onerror = () => reject(new Error("connection failed"));
            });
            socket.send(SafeJSON.stringify({ id: 1, method: "initialize", params: {} }));
            socket.send(SafeJSON.stringify({ id: 2, method: "account/read", params: { refreshToken: false } }));
            const deadline = Date.now() + 2000;
            while (messages.length < 2 && Date.now() < deadline) {
                await Bun.sleep(5);
            }
            expect(messages).toHaveLength(2);
            if (mode === "fixture") {
                expect(server.threadId).toBe("fixture-thread");
            }
            expect(messages[1]).toMatchObject({
                id: 2,
                result: { account: { type: "chatgpt", email: "selected@example.test" } },
            });
            // The native TUI opens a SECOND connection for its own session picker. A single-peer
            // relay destroyed that upgrade and the TUI reported "failed to connect to remote app
            // server"; the answer must also reach only the peer that asked.
            const picker = new WebSocket(`ws+unix://${server.socketPath}:/`);
            const pickerMessages: Array<Record<string, unknown>> = [];
            picker.onmessage = (event) => {
                const message: Record<string, unknown> = SafeJSON.parse(String(event.data), { strict: true });

                if (message.id === 3) {
                    pickerMessages.push(message);
                }
            };
            const admitted = await new Promise<boolean>((resolve) => {
                picker.onopen = () => resolve(true);
                picker.onerror = () => resolve(false);
            });

            expect(admitted).toBe(true);
            picker.send(SafeJSON.stringify({ id: 3, method: "initialize", params: {} }));
            const pickerDeadline = Date.now() + 2000;
            while (pickerMessages.length === 0 && Date.now() < pickerDeadline) {
                await Bun.sleep(5);
            }

            expect(pickerMessages).toHaveLength(1);
            expect(firstPeerIds).not.toContain(3);

            // Closing the picker must not tear down the TUI that opened it.
            picker.close();
            await Bun.sleep(100);
            socket.send(SafeJSON.stringify({ id: 4, method: "initialize", params: {} }));
            const stillAlive = Date.now() + 2000;
            while (!firstPeerIds.includes(4) && Date.now() < stillAlive) {
                await Bun.sleep(5);
            }

            expect(firstPeerIds).toContain(4);
            socket.close();

            // Regression test: the admission latch was set once and never released, so after any
            // websocket drop every later upgrade was destroyed and the native TUI could only be
            // recovered by killing `tools codex run`. The server clears it when the admitted
            // connection closes, which the client observes slightly later, so poll briefly.
            const deadlineForReconnect = Date.now() + 5000;
            let retry: WebSocket | undefined;
            let reconnected = false;
            while (!reconnected && Date.now() < deadlineForReconnect) {
                const attempt = new WebSocket(`ws+unix://${server.socketPath}:/`);
                reconnected = await new Promise<boolean>((resolve) => {
                    attempt.onopen = () => resolve(true);
                    attempt.onerror = () => resolve(false);
                });

                if (reconnected) {
                    retry = attempt;
                    break;
                }

                attempt.close();
                await Bun.sleep(25);
            }
            expect(reconnected).toBe(true);

            // An open socket is not a working one: the bridge is shared, and the first peer's
            // close disconnected it for good, so the replacement used to get the account-bound
            // rejection on every request and no notifications at all.
            const afterReconnect: Array<Record<string, unknown>> = [];
            retry!.onmessage = (event) => {
                afterReconnect.push(SafeJSON.parse(String(event.data), { strict: true }));
            };
            retry!.send(SafeJSON.stringify({ id: 3, method: "account/read", params: { refreshToken: false } }));
            const roundTripDeadline = Date.now() + 5000;
            while (!afterReconnect.some((message) => message.id === 3) && Date.now() < roundTripDeadline) {
                await Bun.sleep(5);
            }
            const answered = afterReconnect.find((message) => message.id === 3);

            expect(answered).toBeDefined();
            expect(answered).not.toHaveProperty("error");
            expect(answered).toMatchObject({ result: { account: { type: "chatgpt" } } });

            if (mode === "fixture") {
                // The fixture app-server emits `thread/started` for every `account/read`, so a
                // relayed notification proves the bridge forwards to the replacement peer too.
                const notificationDeadline = Date.now() + 5000;
                while (
                    !afterReconnect.some((message) => message.method === "thread/started") &&
                    Date.now() < notificationDeadline
                ) {
                    await Bun.sleep(5);
                }

                expect(afterReconnect.some((message) => message.method === "thread/started")).toBe(true);
            }

            retry!.close();
        } finally {
            await server.close();
        }
        expect(existsSync(server.socketPath)).toBe(false);
        expect(readFileSync(join(shared, "auth.json"), "utf8")).toBe(desktopAuth);
        expect(readFileSync(authFile, "utf8")).toBe(before);
    },
    30000
);

test("aborting initialization closes the app-server before its timeout", async () => {
    // Regression test: PR #370 review thread 2 — wrapper signals were installed only after initialization.
    const child: AppServerProcess = Bun.spawn([process.execPath, "--eval", "setInterval(() => {}, 1000)"], {
        env: process.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
    const abort = new AbortController();
    const opening = openTerminalServer({
        account: {
            authenticate: async () => undefined,
            refresh: async () => ({ accessToken: "invented", chatgptAccountId: "fixture" }),
        },
        child,
        signal: abort.signal,
    });
    abort.abort(new Error("wrapper terminated"));
    try {
        const outcome = await Promise.race([
            opening.then(
                () => "opened" as const,
                (error) => error
            ),
            Bun.sleep(250).then(() => "still pending" as const),
        ]);

        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toContain("wrapper terminated");
        expect(await Promise.race([child.exited, Bun.sleep(1000).then(() => "still running")])).not.toBe(
            "still running"
        );
    } finally {
        child.kill("SIGKILL");
        await opening.catch(() => undefined);
    }
});
/**
 * Two app-servers that initialize the SAME CODEX_HOME in the same instant fight over its
 * sqlite state runtime and one dies. Measured 2026-09-11: two simultaneous cold starts on one
 * home left one survivor, while the same two started a second apart both ran and a third then
 * joined them, each reporting its own account's usage. So the launcher retries rather than
 * failing, and this is the sentence it recognises.
 */
test("a home-init race is recognised, and an unrelated failure is not", () => {
    expect(isHomeInitRace("Error: failed to initialize sqlite state runtime under /tmp/x\n")).toBe(true);
    expect(isHomeInitRace("failed to initialize state runtime at /tmp/x")).toBe(true);
    expect(isHomeInitRace("Error: no such file or directory (os error 2)")).toBe(false);
    expect(isHomeInitRace("")).toBe(false);
});

/** An app-server that prints one line on stderr and exits, exactly as the loser of the race does. */
function childThatDies(stderrText: string): AppServerProcess {
    const encoder = new TextEncoder();

    return {
        pid: 0,
        stdin: { write: () => 0, flush: () => 0, end: () => 0 },
        stdout: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            },
        }),
        stderr: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(stderrText));
                controller.close();
            },
        }),
        // Deferred so the stderr pump is drained first: the exit is what rejects the pending
        // request, and the tail is what classifies it.
        exited: new Promise<number>((resolve) => setTimeout(() => resolve(1), 50)),
        kill: () => undefined,
    };
}

const neverAsked = {
    authenticate: () => Promise.reject(new Error("the handshake never got this far")),
    refresh: () => Promise.reject(new Error("the handshake never got this far")),
};

test("losing the home race is reported as a retryable busy home, not as a bare exit", async () => {
    const child = childThatDies("Error: failed to initialize sqlite state runtime under /tmp/gt-codex-home\n");
    await expect(openTerminalServer({ account: neverAsked, child })).rejects.toBeInstanceOf(CodexHomeBusyError);
});

test("an app-server that dies for any other reason keeps its own error", async () => {
    const child = childThatDies("Error: codex: command not found\n");
    const caught = await openTerminalServer({ account: neverAsked, child }).catch((error: unknown) => error);
    expect(caught).not.toBeInstanceOf(CodexHomeBusyError);
    expect(String(caught)).toContain("exited with code 1");
});
