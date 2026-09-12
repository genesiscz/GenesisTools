import { expect, spyOn, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { AppServerClient, type AppServerProcess } from "./app-server-client";
import { CodexTuiBridge } from "./tui-bridge";

function wire() {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let reportExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
        reportExit = resolve;
    });
    let killed = 0;
    const requests: Array<{ id?: number; method?: string; params?: unknown }> = [];
    const push = (message: object) => controller.enqueue(new TextEncoder().encode(`${SafeJSON.stringify(message)}\n`));
    const child: AppServerProcess = {
        pid: 42,
        stdin: {
            write(text) {
                const message = SafeJSON.parse(String(text), { strict: true });
                requests.push(message);
                if (message.method === "initialize") {
                    push({ id: message.id, result: { userAgent: "fixture" } });
                } else if (message.method === "account/login/start") {
                    push({ id: message.id, result: { type: "chatgptAuthTokens" } });
                } else if (message.id && message.method) {
                    push({ id: message.id, result: { echoed: message.method } });
                }
                return String(text).length;
            },
            end() {
                return undefined;
            },
        },
        stdout: new ReadableStream({
            start(c) {
                controller = c;
            },
        }),
        stderr: new ReadableStream(),
        exited,
        // A real app-server exits when it is signalled; a fixture whose `exited` never settles
        // makes close() sit through its whole reap budget on every test.
        kill() {
            killed += 1;
            reportExit(0);
        },
    };
    const messages: Array<Record<string, unknown>> = [];
    const client = new AppServerClient(child);
    const failures: Array<{ method: string; error: Error }> = [];
    const bridge = new CodexTuiBridge({
        client,
        send: (message) => messages.push(message),
        onRequestFailed: (failure) => failures.push(failure),
    });
    return { client, bridge, messages, requests, push, failures, killCount: () => killed };
}

test("closing the client signals the app-server and waits for it to go away", async () => {
    const w = wire();
    w.bridge.ready({ userAgent: "fixture" });
    await w.client.close();
    expect(w.killCount()).toBeGreaterThan(0);
    await expect(w.client.process.exited).resolves.toBe(0);
});

test("native TUI handshake reuses the authenticated app-server connection", async () => {
    const w = wire();
    try {
        const initialized = await w.client.request<Record<string, unknown>>("initialize", {
            capabilities: { experimentalApi: true },
        });
        await w.client.request("account/login/start", {
            type: "chatgptAuthTokens",
            accessToken: "secret",
            chatgptAccountId: "workspace-a",
        });
        w.bridge.ready(initialized);
        await w.bridge.receive({ id: 1, method: "initialize", params: { clientInfo: { name: "codex-tui" } } });
        await w.bridge.receive({ method: "initialized" });
        await w.bridge.receive({ id: 2, method: "thread/list", params: {} });
        expect(w.messages).toEqual([
            { id: 1, result: { userAgent: "fixture" } },
            { id: 2, result: { echoed: "thread/list" } },
        ]);
        expect(w.requests.filter((request) => request.method === "initialize")).toHaveLength(1);
    } finally {
        await w.client.close();
    }
});

test.each(["account/logout", "account/login/start", "config/batchWrite", "config/value/write"])(
    "refuses %s on an account-bound terminal",
    async (method) => {
        const w = wire();
        try {
            w.bridge.ready({ userAgent: "fixture" });
            await w.bridge.receive({ id: 9, method, params: {} });
            expect(w.messages[0]).toMatchObject({ id: 9, error: { code: -32600 } });
            expect(w.requests).toHaveLength(0);
        } finally {
            await w.client.close();
        }
    }
);

test("forwards approvals and releases a waiting server when the terminal disconnects", async () => {
    const w = wire();
    try {
        w.bridge.ready({ userAgent: "fixture" });
        const approval = w.bridge.serverRequest({
            id: 20,
            method: "item/commandExecution/requestApproval",
            params: { command: "touch example" },
        });
        expect(w.messages[0]).toMatchObject({
            method: "item/commandExecution/requestApproval",
            params: { command: "touch example" },
        });
        await w.bridge.receive({ id: w.messages[0].id, result: { decision: "accept" } });
        await expect(approval).resolves.toEqual({ decision: "accept" });
        const pending = w.bridge.serverRequest({ id: 21, method: "item/fileChange/requestApproval", params: {} });
        w.bridge.disconnect();
        await expect(pending).rejects.toThrow("disconnected");
    } finally {
        await w.client.close();
    }
});

test("a reconnected terminal serves requests and notifications again", async () => {
    // Regression test: PR #370 review thread 5 — the terminal server admits a replacement peer on
    // the SAME bridge, so a one-way disconnect left the new socket open but answered every
    // request with the account-bound rejection and dropped every notification.
    const w = wire();
    try {
        w.bridge.ready({ userAgent: "fixture" });
        const abandoned = w.bridge.serverRequest({ id: 30, method: "item/fileChange/requestApproval", params: {} });
        w.bridge.disconnect();
        await expect(abandoned).rejects.toThrow("disconnected");
        w.messages.length = 0;

        // Still disconnected: this is the state the replacement socket used to be admitted into.
        await w.bridge.receive({ id: 31, method: "initialize", params: {} });
        expect(w.messages[0]).toMatchObject({ id: 31, error: { code: -32600 } });

        w.messages.length = 0;
        w.bridge.connect();
        await w.bridge.receive({ id: 32, method: "initialize", params: {} });
        w.bridge.notification({ method: "thread/started", params: { thread: { id: "fixture-thread" } } });

        expect(w.messages[0]).toEqual({ id: 32, result: { userAgent: "fixture" } });
        expect(w.messages[1]).toEqual({
            method: "thread/started",
            params: { thread: { id: "fixture-thread" } },
        });
        const approval = w.bridge.serverRequest({
            id: 33,
            method: "item/commandExecution/requestApproval",
            params: { command: "touch example" },
        });
        const forwarded = w.messages[2];

        expect(forwarded).toMatchObject({ method: "item/commandExecution/requestApproval" });
        await w.bridge.receive({ id: forwarded?.id, result: { decision: "accept" } });
        await expect(approval).resolves.toEqual({ decision: "accept" });
    } finally {
        await w.client.close();
    }
});

test("refuses nested provider overrides before forwarding thread start", async () => {
    const w = wire();
    try {
        w.bridge.ready({ userAgent: "fixture" });
        await w.bridge.receive({
            id: 3,
            method: "thread/start",
            params: { config: { model_providers: { openai: { base_url: "https://elsewhere.invalid" } } } },
        });
        expect(w.requests).toHaveLength(0);
        expect(w.messages[0]).toHaveProperty("error");
    } finally {
        await w.client.close();
    }
});

test("rejects the protocol's top-level modelProvider override", async () => {
    const w = wire();
    try {
        w.bridge.ready({ userAgent: "fixture" });
        await w.bridge.receive({ id: 4, method: "thread/start", params: { modelProvider: "ollama" } });
        expect(w.requests).toHaveLength(0);
        expect(w.messages[0]).toHaveProperty("error");
    } finally {
        await w.client.close();
    }
});

test("an identity override wrapped in a list is still refused", async () => {
    // changesIdentity used to return false for every array, so a params shape that puts the
    // override inside a list walked straight past the account-bind guard.
    const w = wire();
    try {
        w.bridge.ready({ userAgent: "fixture" });
        await w.bridge.receive({
            id: 5,
            method: "thread/start",
            params: { overrides: [{ model_provider: "custom", chatgpt_base_url: "https://elsewhere.invalid" }] },
        });
        expect(w.requests).toHaveLength(0);
        expect(w.messages[0]).toHaveProperty("error");
    } finally {
        await w.client.close();
    }
});

test("relay diagnostics retain the native RPC failure", async () => {
    // Regression test: PR #370 review thread 14 — request failures were logged without their cause.
    const w = wire();
    // A console warn here lands inside the native TUI's screen. The failure goes to the file log
    // and to the launcher, which reports it after the TUI exits.
    const warning = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
        w.bridge.ready({ userAgent: "fixture" });
        await w.client.close();
        await w.bridge.receive({ id: 5, method: "thread/list", params: {} });

        expect(warning).not.toHaveBeenCalled();
        expect(w.failures).toEqual([{ method: "thread/list", error: expect.any(Error) }]);
        expect(w.messages[0]).toMatchObject({ id: 5, error: { code: -32000 } });
    } finally {
        warning.mockRestore();
        await w.client.close();
    }
});

test("losing the primary peer settles requests that were addressed to it", async () => {
    // Regression test: the multi-peer relay (aa8f7b2cd) rejects `pending` only inside
    // disconnect(), and terminal-server calls disconnect() only when the LAST peer leaves. With
    // the session picker still open, the primary TUI closing left every in-flight server request
    // unsettled and the awaiting caller hung forever.
    const w = wire();
    try {
        w.bridge.ready({ userAgent: "fixture" });
        const orphaned = w.bridge.serverRequest({ id: 40, method: "item/fileChange/requestApproval", params: {} });

        w.bridge.failPending("Codex terminal primary disconnected");

        await expect(orphaned).rejects.toThrow("primary disconnected");
        // The relay stays up for the peer that took over, unlike disconnect().
        w.messages.length = 0;
        await w.bridge.receive({ id: 41, method: "initialize", params: {} });
        expect(w.messages[0]).not.toMatchObject({ id: 41, error: { code: -32600 } });
    } finally {
        await w.client.close();
    }
});
