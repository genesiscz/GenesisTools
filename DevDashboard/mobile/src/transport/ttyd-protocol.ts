import { SafeJSON } from "@genesiscz/utils/json";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const INPUT = "0".charCodeAt(0);
const RESIZE = "1".charCodeAt(0);
const OUTPUT = "0";
const TITLE = "1";
const PREFERENCES = "2";

export interface TtydDimensions {
    columns: number;
    rows: number;
}

export type TtydServerFrame =
    | { type: "output"; data: ArrayBuffer }
    | { type: "title"; title: string }
    | { type: "preferences"; preferences: unknown }
    | { type: "unknown"; command: string };

function bytesOf(data: string | ArrayBufferLike): Uint8Array {
    return typeof data === "string" ? encoder.encode(data) : new Uint8Array(data as ArrayBuffer);
}

function payloadWithCommand(command: number, data: Uint8Array): ArrayBuffer {
    const frame = new Uint8Array(data.length + 1);
    frame[0] = command;
    frame.set(data, 1);
    return frame.buffer;
}

export function encodeTtydInit(dimensions: TtydDimensions, authToken = ""): ArrayBuffer {
    return encoder.encode(SafeJSON.stringify({ AuthToken: authToken, ...dimensions })).buffer as ArrayBuffer;
}

export function encodeTtydInput(data: string | ArrayBufferLike): ArrayBuffer {
    return payloadWithCommand(INPUT, bytesOf(data));
}

export function encodeTtydResize(dimensions: TtydDimensions): ArrayBuffer {
    return payloadWithCommand(RESIZE, encoder.encode(SafeJSON.stringify(dimensions)));
}

export function decodeTtydFrame(data: string | ArrayBuffer): TtydServerFrame {
    const bytes = bytesOf(data);
    const command = String.fromCharCode(bytes[0] ?? 0);
    const payload = bytes.slice(1);

    if (command === OUTPUT) {
        return { type: "output", data: payload.buffer as ArrayBuffer };
    }

    if (command === TITLE) {
        return { type: "title", title: decoder.decode(payload) };
    }

    if (command === PREFERENCES) {
        try {
            return { type: "preferences", preferences: SafeJSON.parse(decoder.decode(payload), { strict: true }) };
        } catch {
            return { type: "preferences", preferences: undefined };
        }
    }

    return { type: "unknown", command };
}
