import { describe, expect, test } from "bun:test";
import { parseWritePolicy, resolveWritePolicy } from "./spawn";

describe("resolveWritePolicy", () => {
    test("defaults to a read-only reviewer", () => {
        expect(resolveWritePolicy()).toEqual({
            writePolicy: "deny",
            sandbox: "read-only",
            approvalPolicy: "never",
        });
    });

    test("maps allow and ask to workspace-write with different approvals", () => {
        expect(resolveWritePolicy("allow")).toEqual({
            writePolicy: "allow",
            sandbox: "workspace-write",
            approvalPolicy: "never",
        });
        expect(resolveWritePolicy("ask")).toEqual({
            writePolicy: "ask",
            sandbox: "workspace-write",
            approvalPolicy: "untrusted",
        });
    });

    test("rejects unknown write policies instead of silently using deny", () => {
        expect(parseWritePolicy(undefined)).toBeUndefined();
        expect(parseWritePolicy("ask")).toBe("ask");
        expect(() => parseWritePolicy("sometimes")).toThrow("--write must be ask, allow, or deny");
    });

    test("keeps explicit deny read-only", () => {
        expect(resolveWritePolicy("deny")).toEqual({
            writePolicy: "deny",
            sandbox: "read-only",
            approvalPolicy: "never",
        });
    });
});
