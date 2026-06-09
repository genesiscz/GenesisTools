import { SafeJSON } from "@app/utils/json";

const FRAME_RE = /~m~(\d+)~m~/g;

export function encodeFrame(payload: object | string): string {
    const s = typeof payload === "string" ? payload : SafeJSON.stringify(payload);
    return `~m~${s.length}~m~${s}`;
}

export function parseFrames(message: string): string[] {
    const frames: string[] = [];
    FRAME_RE.lastIndex = 0;
    let match = FRAME_RE.exec(message);
    while (match !== null) {
        const len = Number(match[1]);
        const start = FRAME_RE.lastIndex;
        frames.push(message.slice(start, start + len));
        FRAME_RE.lastIndex = start + len;
        match = FRAME_RE.exec(message);
    }
    return frames;
}

export function isHeartbeat(frame: string): boolean {
    return frame.startsWith("~h~");
}

export function heartbeatEcho(frame: string): string {
    return encodeFrame(frame);
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function genSessionId(prefix: string): string {
    let out = "";
    for (let i = 0; i < 12; i++) {
        out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return prefix + out;
}
