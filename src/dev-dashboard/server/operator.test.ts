import { describe, expect, it } from "bun:test";
import { sanitizeOperator } from "./operator";

describe("sanitizeOperator", () => {
    it("drops control characters and trims", () => {
        expect(sanitizeOperator("  al\u0000ice\u007f\n ")).toBe("alice");
    });

    it("caps the name at 40 characters", () => {
        expect(sanitizeOperator("x".repeat(80))).toHaveLength(40);
    });

    it("keeps a name that is already clean", () => {
        expect(sanitizeOperator("Dana Q.")).toBe("Dana Q.");
    });
});
