import { describe, expect, it } from "bun:test";
import { isNamedKey, keyToBytes } from "@/features/terminals/keymap";

describe("keymap", () => {
    it("maps Escape to \\x1b", () => {
        expect(keyToBytes("Escape")).toBe("\x1b");
    });

    it("maps Tab to \\t", () => {
        expect(keyToBytes("Tab")).toBe("\t");
    });

    it("maps the four arrows to their CSI sequences", () => {
        expect(keyToBytes("ArrowUp")).toBe("\x1b[A");
        expect(keyToBytes("ArrowDown")).toBe("\x1b[B");
        expect(keyToBytes("ArrowRight")).toBe("\x1b[C");
        expect(keyToBytes("ArrowLeft")).toBe("\x1b[D");
    });

    it("maps PageUp / PageDown to CSI 5~ / 6~", () => {
        expect(keyToBytes("PageUp")).toBe("\x1b[5~");
        expect(keyToBytes("PageDown")).toBe("\x1b[6~");
    });

    it("maps Ctrl+c to ETX (0x03)", () => {
        expect(keyToBytes("c", { ctrl: true })).toBe("\x03");
    });

    it("maps Ctrl+a / Ctrl+d / Ctrl+z to their control codes", () => {
        expect(keyToBytes("a", { ctrl: true })).toBe(String.fromCharCode(0x01));
        expect(keyToBytes("d", { ctrl: true })).toBe(String.fromCharCode(0x04));
        expect(keyToBytes("z", { ctrl: true })).toBe(String.fromCharCode(0x1a));
    });

    it("is case-insensitive for Ctrl letters (Ctrl+C === Ctrl+c)", () => {
        expect(keyToBytes("C", { ctrl: true })).toBe(keyToBytes("c", { ctrl: true }));
    });

    it("prefixes ESC for Alt (meta) on a plain character", () => {
        expect(keyToBytes("b", { alt: true })).toBe("\x1bb");
    });

    it("passes a plain printable character through unchanged", () => {
        expect(keyToBytes("/")).toBe("/");
        expect(keyToBytes("~")).toBe("~");
    });

    it("isNamedKey distinguishes named keys from characters", () => {
        expect(isNamedKey("Escape")).toBe(true);
        expect(isNamedKey("ArrowUp")).toBe(true);
        expect(isNamedKey("c")).toBe(false);
        expect(isNamedKey("/")).toBe(false);
    });
});
