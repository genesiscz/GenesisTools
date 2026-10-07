import { describe, expect, it, mock, spyOn } from "bun:test";

// `terminal-ws.ts` statically imports `partysocket` (a WebSocket impl) and `react-native`
// (`AppState`), both unloadable under bun. Stub them so the ttyd codec and socket wiring run under Bun.
mock.module("partysocket", () => ({ WebSocket: class {} }));
mock.module("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));

const { createTerminalTransport } = await import("@/transport/terminal-ws");
const { decodeTtydFrame, encodeTtydInput } = await import("@/transport/ttyd-protocol");

class FakeSocket {
    binaryType = "";
    sent: (string | ArrayBuffer)[] = [];
    reconnects = 0;
    private listeners = new Map<string, ((event: unknown) => void)[]>();

    send(data: string | ArrayBuffer) {
        this.sent.push(data);
    }

    close() {}

    reconnect() {
        this.reconnects += 1;
    }

    addEventListener(type: string, listener: (event: unknown) => void) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: unknown) => void) {
        this.listeners.set(
            type,
            (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener)
        );
    }

    emit(type: string, event: unknown = {}) {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

function bytes(data: string | ArrayBuffer): number[] {
    return [...new Uint8Array(data as ArrayBuffer)];
}

describe("ttyd protocol transport", () => {
    it("initializes before input, frames resize, and re-initializes with current dimensions", () => {
        const socket = new FakeSocket();
        const transport = createTerminalTransport({
            wsUrl: "ws://agent/ttyd/1/ws",
            dimensions: { columns: 90, rows: 30 },
            socketFactory: () => socket as never,
        });

        socket.emit("open");
        expect(new TextDecoder().decode(socket.sent[0] as ArrayBuffer)).toBe(
            '{"AuthToken":"","columns":90,"rows":30}'
        );

        transport.send("abc");
        expect(bytes(socket.sent[1] as ArrayBuffer)).toEqual([48, 97, 98, 99]);

        transport.resize(120, 40);
        expect(new TextDecoder().decode((socket.sent[2] as ArrayBuffer).slice(1))).toBe('{"columns":120,"rows":40}');

        socket.emit("open");
        expect(new TextDecoder().decode(socket.sent[3] as ArrayBuffer)).toBe(
            '{"AuthToken":"","columns":120,"rows":40}'
        );
    });

    it("emits only decoded output and consumes title/preferences metadata", () => {
        const socket = new FakeSocket();
        const transport = createTerminalTransport({
            wsUrl: "ws://agent/ttyd/1/ws",
            socketFactory: () => socket as never,
        });
        const output: string[] = [];
        transport.onMessage((data) => output.push(new TextDecoder().decode(data as ArrayBuffer)));

        socket.emit("message", { data: encodeTtydInput("hello") });
        socket.emit("message", { data: new Uint8Array([49, ...new TextEncoder().encode("title")]).buffer });
        socket.emit("message", { data: new Uint8Array([50, 123, 125]).buffer });

        expect(output).toEqual(["hello"]);
    });

    it("drops a frame the wire decoder rejects instead of reading it as plaintext", () => {
        const socket = new FakeSocket();
        const transport = createTerminalTransport({
            wsUrl: "ws://agent/ttyd/1/ws",
            socketFactory: () => socket as never,
            wire: { encode: (frame) => frame, decode: () => null },
        });
        const output: string[] = [];
        transport.onMessage((data) => output.push(new TextDecoder().decode(data as ArrayBuffer)));

        socket.emit("message", { data: encodeTtydInput("injected output") });

        expect(output).toEqual([]);
    });

    it("keeps a healthy idle socket open without an invented ping timer", () => {
        const interval = spyOn(globalThis, "setInterval");
        const socket = new FakeSocket();
        createTerminalTransport({ wsUrl: "ws://agent/ttyd/1/ws", socketFactory: () => socket as never });
        socket.emit("open");

        expect(interval).not.toHaveBeenCalled();
        expect(socket.reconnects).toBe(0);
        expect(socket.sent).toHaveLength(1);
        interval.mockRestore();
    });

    it("decodes the official server command discriminator", () => {
        const frame = decodeTtydFrame(new Uint8Array([48, 65, 66]).buffer);
        expect(frame.type).toBe("output");
        expect(frame.type === "output" ? bytes(frame.data) : []).toEqual([65, 66]);
    });
});
