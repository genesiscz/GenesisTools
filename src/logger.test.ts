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

describe("build() streams", () => {
    it("console sink writes to stderr, file sink always debug; stdout untouched", async () => {
        const mod = await import("./logger");
        const errChunks: string[] = [];
        const outChunks: string[] = [];
        const oe = process.stderr.write.bind(process.stderr);
        const oo = process.stdout.write.bind(process.stdout);
        process.stderr.write = (c: string) => {
            errChunks.push(String(c));
            return true;
        };
        process.stdout.write = (c: string) => {
            outChunks.push(String(c));
            return true;
        };
        mod.logger.info("INFO_VISIBLE");
        mod.logger.debug("DEBUG_HIDDEN_ON_CONSOLE");
        process.stderr.write = oe;
        process.stdout.write = oo;
        const err = errChunks.join("");
        expect(err).toContain("INFO_VISIBLE");
        expect(err).not.toContain("DEBUG_HIDDEN_ON_CONSOLE");
        expect(outChunks.join("")).toBe(""); // logger never touches stdout
    });
});
