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

describe("level resolution + child propagation", () => {
    // Plan's literal test asserted log.isLevelEnabled("debug") === false, which
    // contradicts Task 2's architecture (root pino stays "trace" → isLevelEnabled
    // is always true; the GATE is the mechanism). Plan comment says "assert the
    // gate by capturing stderr" — this is that, as a clean before/after proving
    // a child created BEFORE the level change is retroactively re-gated.
    it("mutating console level retroactively re-gates a pre-created scoped child", async () => {
        const mod = await import("./logger");
        const { log } = mod.logger.scoped("test:child"); // created BEFORE the change
        const chunks: string[] = [];
        const oe = process.stderr.write.bind(process.stderr);
        process.stderr.write = (c: string) => {
            chunks.push(String(c));
            return true;
        };
        log.debug("CHILD_DEBUG_BEFORE"); // gate=info default → dropped from console
        mod.setConsoleLevel("debug"); // retroactively lowers the gate
        log.debug("CHILD_DEBUG_AFTER"); // same pre-created child → now visible
        process.stderr.write = oe;
        const out = chunks.join("");
        expect(out).not.toContain("CHILD_DEBUG_BEFORE");
        expect(out).toContain("CHILD_DEBUG_AFTER");
    });
});

describe("configureLogger in-place", () => {
    it("force-debug sets the console gate without rebuilding the instance", async () => {
        const mod = await import("./logger");
        const ref = mod.logger;
        mod.setConsoleLevel("warn"); // neutralize prior tests — debug now hidden
        mod.configureLogger({ level: "debug" }); // must drive the gate, not rebuild
        expect(mod.logger).toBe(ref); // identity unchanged (no rebuild)
        const chunks: string[] = [];
        const oe = process.stderr.write.bind(process.stderr);
        process.stderr.write = (c: string) => {
            chunks.push(String(c));
            return true;
        };
        mod.logger.debug("FORCED_DEBUG");
        process.stderr.write = oe;
        expect(chunks.join("")).toContain("FORCED_DEBUG");
    });

    it("createLogger({logToFile:false}) yields a file-less pino (daemons)", async () => {
        const mod = await import("./logger");
        const d = mod.createLogger({ logToFile: false, minimalLevels: true });
        expect(typeof d.info).toBe("function");
    });
});
