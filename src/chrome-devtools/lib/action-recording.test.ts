import { afterEach, describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    type ActionRecordingSnapshot,
    redactBrowserText,
    startActionRecording,
    validBrowserLocator,
} from "./action-recording";

interface CdpCall {
    method: string;
    params: Record<string, unknown>;
}

interface CdpMessage {
    id: number;
    method: string;
    params?: Record<string, unknown>;
}

const servers: { stop: (force?: boolean) => void }[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) {
        server.stop(true);
    }
});

/** A local CDP endpoint: one HTTP page target and a page socket that records every call it answers. */
function fakeCdp(options: { admit: boolean }) {
    const calls: CdpCall[] = [];
    const sockets: { send: (data: string) => void }[] = [];
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request, self) {
            if (new URL(request.url).pathname === "/json/list") {
                return Response.json([
                    {
                        id: "page-1",
                        type: "page",
                        title: "Fixture",
                        url: "http://localhost/fixture?access_token=fixture-secret",
                        webSocketDebuggerUrl: `ws://127.0.0.1:${self.port}/devtools/page/page-1`,
                    },
                ]);
            }

            if (self.upgrade(request)) {
                return undefined;
            }

            return new Response("not found", { status: 404 });
        },
        websocket: {
            open(socket) {
                sockets.push(socket);
            },
            message(socket, raw) {
                const message = SafeJSON.parse(String(raw), { strict: true }) as CdpMessage;
                calls.push({ method: message.method, params: message.params ?? {} });
                let result: unknown = {};
                if (message.method === "Runtime.evaluate") {
                    const admission = calls.filter((call) => call.method === "Runtime.evaluate").length === 1;
                    result = { result: { value: admission ? options.admit : true } };
                }

                if (message.method === "Page.addScriptToEvaluateOnNewDocument") {
                    result = { identifier: "script-1" };
                }

                socket.send(SafeJSON.stringify({ id: message.id, result }, { strict: true }));
            },
        },
    });
    servers.push(server);
    const emit = (method: string, params: Record<string, unknown>) => {
        for (const socket of sockets) {
            socket.send(SafeJSON.stringify({ method, params }, { strict: true }));
        }
    };
    return { port: Number(server.port), calls, emit };
}

function updateWaiter() {
    const updates: ActionRecordingSnapshot[] = [];
    let wake: (() => void) | undefined;
    const onUpdate = (snapshot: ActionRecordingSnapshot) => {
        updates.push(snapshot);
        wake?.();
    };
    const until = async (check: (latest: ActionRecordingSnapshot | undefined) => boolean) => {
        while (!check(updates.at(-1))) {
            await new Promise<void>((resolve) => {
                wake = resolve;
            });
        }
    };
    return { updates, onUpdate, until };
}

describe("redactBrowserText", () => {
    test("redacts standard OAuth credential parameters and assignments", () => {
        const url =
            "https://example.test/callback?access_token=fixture-a&refresh_token=fixture-b&id_token=fixture-c&client_secret=fixture-d&api_key=fixture-e&state=keep";
        const redacted = redactBrowserText(url);
        expect(redacted).not.toContain("fixture-");
        expect(redacted).toContain("access_token=[redacted]");
        expect(redacted).toContain("client_secret=[redacted]");
        expect(redacted).toContain("state=keep");
        expect(redactBrowserText("access_token: fixture-f")).toBe("access_token: [redacted]");
    });

    test("keeps ordinary parameters a generated test needs to navigate", () => {
        expect(redactBrowserText("https://example.test/list?page=2&sort=name")).toBe(
            "https://example.test/list?page=2&sort=name"
        );
    });
});

describe("validBrowserLocator", () => {
    test("refuses a page-supplied name past the bound and accepts a normal one", () => {
        expect(validBrowserLocator({ kind: "role", value: "button", name: "Save" })).toBe(true);
        expect(validBrowserLocator({ kind: "role", value: "button", name: "x".repeat(5000) })).toBe(false);
    });
});

describe("startActionRecording", () => {
    test("refuses a tab another recorder owns without touching its binding or scripts", async () => {
        const cdp = fakeCdp({ admit: false });
        await expect(startActionRecording({ port: cdp.port, targetId: "page-1" })).rejects.toThrow(
            "Another recording owns this tab"
        );
        const methods = cdp.calls.map((call) => call.method);
        expect(methods).not.toContain("Runtime.addBinding");
        expect(methods).not.toContain("Runtime.removeBinding");
        expect(methods).not.toContain("Page.addScriptToEvaluateOnNewDocument");
    });

    test("records validated actions and navigation, drops repeated warnings, and cleans up on stop", async () => {
        const cdp = fakeCdp({ admit: true });
        const waiter = updateWaiter();
        const recording = await startActionRecording({
            port: cdp.port,
            targetId: "page-1",
            onUpdate: waiter.onUpdate,
        });
        const binding = String(cdp.calls.find((call) => call.method === "Runtime.addBinding")?.params.name);
        const action = {
            kind: "click",
            locator: { kind: "role", value: "button", name: "Save", extra: "page-supplied" },
            sourceUrl: "http://localhost/fixture?access_token=fixture-secret",
        };
        const warning = { warning: "Credential input omitted." };
        for (const payload of [action, warning, warning]) {
            cdp.emit("Runtime.bindingCalled", {
                name: binding,
                payload: SafeJSON.stringify(payload, { strict: true }),
            });
        }
        cdp.emit("Page.frameNavigated", { frame: { id: "main", url: "http://localhost/next" } });
        await waiter.until((latest) => latest?.actions.some((item) => item.kind === "navigate") === true);

        const latest = waiter.updates.at(-1);
        expect(latest?.actions.map((item) => item.kind)).toEqual(["click", "navigate"]);
        expect(latest?.actions[0].locator).toEqual({ kind: "role", value: "button", name: "Save" });
        expect(latest?.actions[0].sourceUrl).not.toContain("fixture-secret");
        expect(latest?.evidence.filter((item) => item.kind === "warning")).toHaveLength(1);

        const final = await recording.stop();
        expect(final.initialUrl).not.toContain("fixture-secret");
        const methods = cdp.calls.map((call) => call.method);
        expect(methods).toContain("Page.removeScriptToEvaluateOnNewDocument");
        expect(methods).toContain("Runtime.removeBinding");
        expect(cdp.calls.at(-1)?.method).toBe("Runtime.evaluate");
        expect(String(cdp.calls.at(-1)?.params.expression)).toContain("__genesisRecordingCleanup");
    });

    test("cancellation stops the recording and runs the same cleanup", async () => {
        const cdp = fakeCdp({ admit: true });
        const controller = new AbortController();
        const recording = await startActionRecording({ port: cdp.port, targetId: "page-1", signal: controller.signal });
        controller.abort();
        await recording.stop();
        expect(cdp.calls.map((call) => call.method)).toContain("Runtime.removeBinding");
    });
});
