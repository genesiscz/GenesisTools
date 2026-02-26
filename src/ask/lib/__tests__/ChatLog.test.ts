import { describe, expect, it } from "bun:test";
import { ChatLog } from "../ChatLog";

describe("ChatLog", () => {
    it("captures logs at or above configured level", () => {
        const log = new ChatLog("warn");
        log.capture("info", "should be ignored", "Source");
        log.capture("warn", "visible warning", "DynamicPricing");
        log.capture("error", "visible error", "ProviderManager");

        const all = log.getAll();
        expect(all).toHaveLength(2);
        expect(all[0].message).toBe("visible warning");
        expect(all[0].source).toBe("DynamicPricing");
    });

    it("getUnseen returns entries since last call", () => {
        const log = new ChatLog("info");
        log.capture("info", "first");
        log.capture("info", "second");

        const batch1 = log.getUnseen();
        expect(batch1).toHaveLength(2);

        log.capture("info", "third");
        const batch2 = log.getUnseen();
        expect(batch2).toHaveLength(1);
        expect(batch2[0].message).toBe("third");
    });

    it("getUnseen with level filter", () => {
        const log = new ChatLog("info");
        log.capture("info", "info msg");
        log.capture("warn", "warn msg");
        log.capture("error", "error msg");

        const warnings = log.getUnseen({ level: "warn" });
        expect(warnings).toHaveLength(2); // warn + error
    });

    it("silent level captures nothing", () => {
        const log = new ChatLog("silent");
        log.capture("error", "should not appear");
        expect(log.getAll()).toHaveLength(0);
    });

    it("clear resets everything", () => {
        const log = new ChatLog("info");
        log.capture("info", "test");
        log.clear();
        expect(log.getAll()).toHaveLength(0);
        expect(log.getUnseen()).toHaveLength(0);
    });

    it("createLogger produces a pino-compatible interface", () => {
        const log = new ChatLog("info");
        const logger = log.createLogger("TestSource");
        logger.info("hello from logger");
        logger.warn("warning from logger");
        logger.debug("should be ignored at info level");

        const entries = log.getAll();
        expect(entries).toHaveLength(2);
        expect(entries[0].source).toBe("TestSource");
    });
});
