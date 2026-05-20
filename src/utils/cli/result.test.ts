import { describe, expect, it } from "bun:test";
import { asResult } from "./result";

describe("asResult", () => {
    it("strings pass through with a trailing newline; objects → SafeJSON + newline", () => {
        expect(asResult("hello")).toBe("hello\n");
        expect(asResult("hello\n")).toBe("hello\n"); // idempotent newline
        expect(asResult({ ok: true })).toBe('{"ok":true}\n'); // SafeJSON, never bare JSON
    });
});
