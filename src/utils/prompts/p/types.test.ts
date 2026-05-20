import { describe, expect, it } from "bun:test";
import { clackBackend } from "./clack-backend";

describe("p/ surface extensions", () => {
    it("Log has warning alias and message accepts string[]", () => {
        expect(typeof clackBackend.log.warning).toBe("function");
        expect(() => clackBackend.log.message(["a", "b"])).not.toThrow();
    });
    it("backend exposes password()", () => {
        expect(typeof clackBackend.password).toBe("function");
    });
});
