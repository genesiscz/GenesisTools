import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

/**
 * Tests for @app/logger/client — the browser-safe facade.
 *
 * Verifies:
 * 1. Key-set parity with @app/logger exports
 * 2. logger.scoped() prefixes output with [scope]
 * 3. out.result() writes JSON to console.log
 * 4. out.info/warn/error write styled output
 * 5. Prompt methods throw clear errors
 * 6. No Node-only imports (checked by inspecting the import block separately)
 */

describe("@app/logger/client", () => {
    // biome-ignore lint/suspicious/noExplicitAny: test spy needs flexible capture
    let logs: any[][];
    // biome-ignore lint/suspicious/noExplicitAny: test spy needs flexible capture
    let warns: any[][];
    // biome-ignore lint/suspicious/noExplicitAny: test spy needs flexible capture
    let errors: any[][];
    // biome-ignore lint/suspicious/noExplicitAny: test spy needs flexible capture
    let debugs: any[][];

    let logSpy: ReturnType<typeof spyOn>;
    let warnSpy: ReturnType<typeof spyOn>;
    let errorSpy: ReturnType<typeof spyOn>;
    let debugSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        logs = [];
        warns = [];
        errors = [];
        debugs = [];
        logSpy = spyOn(console, "log").mockImplementation((...args) => {
            logs.push(args);
        });
        warnSpy = spyOn(console, "warn").mockImplementation((...args) => {
            warns.push(args);
        });
        errorSpy = spyOn(console, "error").mockImplementation((...args) => {
            errors.push(args);
        });
        debugSpy = spyOn(console, "debug").mockImplementation((...args) => {
            debugs.push(args);
        });
    });

    afterEach(() => {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        debugSpy.mockRestore();
    });

    describe("key-set parity", () => {
        it("logger has all required methods", async () => {
            const { logger } = await import("./client");
            expect(typeof logger.trace).toBe("function");
            expect(typeof logger.debug).toBe("function");
            expect(typeof logger.info).toBe("function");
            expect(typeof logger.warn).toBe("function");
            expect(typeof logger.error).toBe("function");
            expect(typeof logger.fatal).toBe("function");
            expect(typeof logger.child).toBe("function");
            expect(typeof logger.flush).toBe("function");
            expect(typeof logger.scoped).toBe("function");
            expect(typeof logger.level).toBe("string");
        });

        it("out has all required fields", async () => {
            const { out } = await import("./client");
            expect(typeof out.intro).toBe("function");
            expect(typeof out.outro).toBe("function");
            expect(typeof out.cancel).toBe("function");
            expect(typeof out.note).toBe("function");
            expect(typeof out.log).toBe("object");
            expect(typeof out.log.info).toBe("function");
            expect(typeof out.log.success).toBe("function");
            expect(typeof out.log.warn).toBe("function");
            expect(typeof out.log.warning).toBe("function");
            expect(typeof out.log.error).toBe("function");
            expect(typeof out.log.step).toBe("function");
            expect(typeof out.log.message).toBe("function");
            expect(typeof out.spinner).toBe("function");
            expect(typeof out.text).toBe("function");
            expect(typeof out.confirm).toBe("function");
            expect(typeof out.select).toBe("function");
            expect(typeof out.multiselect).toBe("function");
            expect(typeof out.password).toBe("function");
            expect(typeof out.isCancel).toBe("function");
            expect(typeof out.result).toBe("function");
            expect(typeof out.print).toBe("function");
            expect(typeof out.detail).toBe("function");
            // Shortcuts (COS-T1/T2)
            expect(typeof out.info).toBe("function");
            expect(typeof out.warn).toBe("function");
            expect(typeof out.error).toBe("function");
        });
    });

    describe("logger.scoped()", () => {
        it("log.info() calls console.debug with [scope] prefix", async () => {
            const { logger } = await import("./client");
            const { log } = logger.scoped("foo");
            log.info("bar");
            const combined = debugs.flat().join(" ");
            expect(combined).toContain("[foo]");
            expect(combined).toContain("bar");
        });

        it("returns log and out with matching shape", async () => {
            const { logger } = await import("./client");
            const { log, out: scopedOut } = logger.scoped("test-scope");
            expect(typeof log.debug).toBe("function");
            expect(typeof scopedOut.result).toBe("function");
        });
    });

    describe("out.result()", () => {
        it("writes JSON to console.log", async () => {
            const { out } = await import("./client");
            out.result({ a: 1 });
            expect(logs.flat().join("")).toContain('"a":1');
        });
    });

    describe("out.print()", () => {
        it("writes raw string to console.log", async () => {
            const { out } = await import("./client");
            out.print("RAW_OUTPUT");
            expect(logs.flat().join("")).toContain("RAW_OUTPUT");
        });
    });

    describe("out.info/warn/error shortcuts", () => {
        it("out.info() calls console.log with styled prefix", async () => {
            const { out } = await import("./client");
            out.info("hello info");
            const combined = logs.flat().join(" ");
            expect(combined).toContain("hello info");
        });

        it("out.warn() calls console.warn", async () => {
            const { out } = await import("./client");
            out.warn("hello warn");
            expect(warns.flat().join(" ")).toContain("hello warn");
        });

        it("out.error() calls console.error", async () => {
            const { out } = await import("./client");
            out.error("hello error");
            expect(errors.flat().join(" ")).toContain("hello error");
        });

        it("out.info() passes rest args as formatted string", async () => {
            const { out } = await import("./client");
            out.info("msg", { extra: true });
            const combined = logs.flat().join(" ");
            expect(combined).toContain("msg");
            expect(combined).toContain("extra");
        });
    });

    describe("prompt methods throw", () => {
        it("out.text() throws browser context error", async () => {
            const { out } = await import("./client");
            expect(() => out.text({ message: "hi" })).toThrow("@app/logger/client");
        });

        it("out.confirm() throws browser context error", async () => {
            const { out } = await import("./client");
            expect(() => out.confirm({ message: "ok?" })).toThrow("@app/logger/client");
        });

        it("out.select() throws browser context error", async () => {
            const { out } = await import("./client");
            expect(() => out.select({ message: "pick", options: [] })).toThrow("@app/logger/client");
        });
    });

    describe("isCancel()", () => {
        it("returns true for symbols", async () => {
            const { out } = await import("./client");
            expect(out.isCancel(Symbol("cancel"))).toBe(true);
            expect(out.isCancel("string")).toBe(false);
            expect(out.isCancel(null)).toBe(false);
        });
    });

    describe("spinner()", () => {
        it("is a no-op (start/stop/message don't throw)", async () => {
            const { out } = await import("./client");
            const s = out.spinner();
            expect(() => {
                s.start("loading");
                s.message("still loading");
                s.stop("done");
            }).not.toThrow();
        });
    });

    describe("level getter/setter", () => {
        it("level can be read and set", async () => {
            const { logger } = await import("./client");
            expect(typeof logger.level).toBe("string");
            logger.level = "debug";
            expect(logger.level).toBe("debug");
            logger.level = "info";
        });
    });
});
