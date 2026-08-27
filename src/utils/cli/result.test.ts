import { describe, expect, it } from "bun:test";
import { asResult } from "./result";

describe("asResult", () => {
    it("strings pass through with a trailing newline; objects → SafeJSON + newline", () => {
        expect(asResult("hello")).toBe("hello\n");
        expect(asResult("hello\n")).toBe("hello\n"); // idempotent newline
        expect(asResult({ ok: true })).toBe('{"ok":true}\n'); // SafeJSON, never bare JSON
    });

    it("unserializable payloads become null instead of crashing", () => {
        // SafeJSON.stringify returns undefined here; .endsWith on that used to
        // kill the process mid-command (chrome-devtools eval returning nothing).
        expect(asResult(undefined)).toBe("null\n");
        expect(asResult(() => {})).toBe("null\n");
    });
});
