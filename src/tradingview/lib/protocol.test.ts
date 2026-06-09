import { describe, expect, it } from "bun:test";
import { encodeFrame, genSessionId, heartbeatEcho, isHeartbeat, parseFrames } from "./protocol";

describe("protocol framing", () => {
    it("encodes an object as ~m~<len>~m~<json>", () => {
        expect(encodeFrame({ m: "x", p: [1] })).toBe('~m~17~m~{"m":"x","p":[1]}');
    });

    it("encodes a raw string payload", () => {
        expect(encodeFrame("~h~2")).toBe("~m~4~m~~h~2");
    });

    it("splits a concatenated multi-frame message", () => {
        const msg = '~m~4~m~~h~2~m~13~m~{"m":"hi"}';
        expect(parseFrames(msg)).toEqual(["~h~2", '{"m":"hi"}']);
    });

    it("detects heartbeat tokens", () => {
        expect(isHeartbeat("~h~7")).toBe(true);
        expect(isHeartbeat('{"m":"qsd"}')).toBe(false);
    });

    it("builds a re-wrapped heartbeat echo", () => {
        expect(heartbeatEcho("~h~2")).toBe("~m~4~m~~h~2");
    });

    it("generates a 12-char-ish session id with prefix", () => {
        const id = genSessionId("qs_");
        expect(id.startsWith("qs_")).toBe(true);
        expect(id.length).toBeGreaterThan(8);
    });
});
