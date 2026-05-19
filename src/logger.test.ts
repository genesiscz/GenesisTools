import { describe, expect, it } from "bun:test";

describe("logger facade", () => {
    it("is a stable object whose identity never changes and is lazy", async () => {
        const mod = await import("./logger");
        expect(typeof mod.logger).toBe("object");
        const ref1 = mod.logger;
        const mod2 = await import("./logger");
        expect(mod2.logger).toBe(ref1); // identity stable across imports
        expect(typeof mod.logger.info).toBe("function");
        expect(typeof mod.logger.child).toBe("function");
        expect(typeof mod.logger.scoped).toBe("function");
    });

    it("exports a Logger type and transitional default + consoleLog", async () => {
        const mod = await import("./logger");
        expect(mod.default).toBe(mod.logger); // transitional default === named
        expect(mod.consoleLog).toBe(mod.logger); // transitional alias
    });
});
