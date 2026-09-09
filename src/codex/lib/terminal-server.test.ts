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
import { openTerminalServer } from "./terminal-server";

afterEach(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    AiConfigStore.invalidate();
});

const modes = ["fixture", "setup-failure", ...(env.getProcessEnv().RUN_INTEGRATION === "1" ? ["installed"] : [])];
test.each(
    modes
)("%s terminal endpoint authenticates before serving the native client and cleans up on close", async (mode) => {
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
        socket.onmessage = (event) => {
            const message: Record<string, unknown> = SafeJSON.parse(String(event.data), { strict: true });
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
        socket.close();

        // Regression test: the admission latch was set once and never released, so after any
        // websocket drop every later upgrade was destroyed and the native TUI could only be
        // recovered by killing `tools codex run`. The server clears it when the admitted
        // connection closes, which the client observes slightly later, so poll briefly.
        const deadlineForReconnect = Date.now() + 5000;
        let reconnected = false;
        while (!reconnected && Date.now() < deadlineForReconnect) {
            const retry = new WebSocket(`ws+unix://${server.socketPath}:/`);
            reconnected = await new Promise<boolean>((resolve) => {
                retry.onopen = () => resolve(true);
                retry.onerror = () => resolve(false);
            });
            retry.close();

            if (!reconnected) {
                await Bun.sleep(25);
            }
        }
        expect(reconnected).toBe(true);
    } finally {
        await server.close();
    }
    expect(existsSync(server.socketPath)).toBe(false);
    expect(readFileSync(join(shared, "auth.json"), "utf8")).toBe(desktopAuth);
    expect(readFileSync(authFile, "utf8")).toBe(before);
}, 30000);

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
