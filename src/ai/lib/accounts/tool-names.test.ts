import { describe, expect, test } from "bun:test";
import { siblingCommandOf } from "./tool-names";

describe("siblingCommandOf", () => {
    test("swaps the door's own verb for the sibling one", () => {
        expect(siblingCommandOf("tools claude login-long", "login")).toBe("tools claude login");
        expect(siblingCommandOf("tools claude login-secondary", "login")).toBe("tools claude login");
    });

    test("works for a nested door", () => {
        expect(siblingCommandOf("tools ai accounts login-long", "login")).toBe("tools ai accounts login");
    });

    test("never appends the sibling verb after the door's own", () => {
        expect(siblingCommandOf("tools claude login-long", "login")).not.toContain("login-long login");
    });

    test("surrounding whitespace does not leak into the result", () => {
        expect(siblingCommandOf("  tools claude login-long  ", "login")).toBe("tools claude login");
    });

    test("a single-word tool name gets the verb appended", () => {
        expect(siblingCommandOf("tools", "login")).toBe("tools login");
    });
});
