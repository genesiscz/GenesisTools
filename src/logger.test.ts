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

describe("scoped out + log.out/log.tee double-mirror rule", () => {
    // Plan Task 9 test deviations (faithful):
    //  - plan called `log.out.step(...)` but `step` lives on `Out.log`
    //    (Task 8 Out shape) → real call is `log.out.log.step(...)`.
    //  - plan spied `log.debug`, but out.ts mirrorLine re-scopes via
    //    `logger.scoped(component)` (a DIFFERENT child instance), so that
    //    spy would capture nothing. The real, render-verified discriminator
    //    is the component-tagged pino debug line: clack's step render does
    //    NOT carry `component: "<name>"`; the single mirror debug line does.
    //    Exactly-one occurrence == the no-double-mirror invariant.
    it("log.out.log.* emits EXACTLY ONE component-tagged debug line (mirrorToLogger=true)", async () => {
        const mod = await import("./logger");
        const { configureOut } = await import("./logger/out");
        configureOut({ mirrorToLogger: true });
        mod.setConsoleLevel("debug");
        const { log } = mod.logger.scoped("shops:crawler");
        const chunks: string[] = [];
        const oe = process.stderr.write.bind(process.stderr);
        process.stderr.write = (c: string) => {
            chunks.push(String(c));
            return true;
        };
        log.out.log.step("Crawling");
        await Bun.sleep(20);
        process.stderr.write = oe;
        const stderr = chunks.join("");
        expect((stderr.match(/component: "shops:crawler"/g) ?? []).length).toBe(1);
        expect(stderr).toContain("Crawling");
    });

    it("log.tee === log.out (alias)", async () => {
        const mod = await import("./logger");
        const { log } = mod.logger.scoped("x");
        expect(log.tee).toBe(log.out);
    });
});

// MUST be the LAST describe in this file: setBaseBinding mutates module-level
// state (the _base/_effective child) that persists for the rest of the
// process. Placed last so earlier tests run against the un-bound logger.
// Advisor-mandated (the plan's Task 13 test only exercises runTool's surface;
// without these the eff()/setBaseBinding refactor ships untested).
describe("setBaseBinding + eff() — Task 13", () => {
    it("logger.info after setBaseBinding({tool}) renders the tool binding on stderr", async () => {
        const mod = await import("./logger");
        mod.setConsoleLevel("info");
        mod.setBaseBinding({ tool: "loggertest" });
        const chunks: string[] = [];
        const oe = process.stderr.write.bind(process.stderr);
        process.stderr.write = (c: string) => {
            chunks.push(String(c));
            return true;
        };
        mod.logger.info("base-bound line");
        await Bun.sleep(20);
        process.stderr.write = oe;
        const stderr = chunks.join("");
        expect(stderr).toContain('tool: "loggertest"');
        expect(stderr).toContain("base-bound line");
    });

    it("scoped() flows through eff() — renders BOTH tool and component", async () => {
        const mod = await import("./logger");
        mod.setConsoleLevel("debug");
        mod.setBaseBinding({ tool: "loggertest" });
        const { log } = mod.logger.scoped("scopecomp");
        const chunks: string[] = [];
        const oe = process.stderr.write.bind(process.stderr);
        process.stderr.write = (c: string) => {
            chunks.push(String(c));
            return true;
        };
        log.info("scoped base-bound line");
        await Bun.sleep(20);
        process.stderr.write = oe;
        const stderr = chunks.join("");
        expect(stderr).toContain('tool: "loggertest"');
        expect(stderr).toContain('component: "scopecomp"');
    });
});
