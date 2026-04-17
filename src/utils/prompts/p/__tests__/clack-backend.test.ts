import { describe, expect, it } from "bun:test";
import { clackBackend } from "../clack-backend";

describe("clack backend", () => {
    it("exposes all required methods", () => {
        expect(typeof clackBackend.intro).toBe("function");
        expect(typeof clackBackend.outro).toBe("function");
        expect(typeof clackBackend.text).toBe("function");
        expect(typeof clackBackend.confirm).toBe("function");
        expect(typeof clackBackend.typedConfirm).toBe("function");
        expect(typeof clackBackend.select).toBe("function");
        expect(typeof clackBackend.multiselect).toBe("function");
        expect(typeof clackBackend.spinner).toBe("function");
        expect(clackBackend.log.info).toBeDefined();
    });
});
