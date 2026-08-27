import { describe, expect, test } from "bun:test";
import { classifyCmuxHealth } from "@genesiscz/utils/cmux/lib/health";

describe("classifyCmuxHealth", () => {
    test("ping + identify ok is healthy regardless of app detection", () => {
        expect(classifyCmuxHealth({ appRunning: true, pingOk: true, identifyOk: true })).toBe("healthy");
        expect(classifyCmuxHealth({ appRunning: false, pingOk: true, identifyOk: true })).toBe("healthy");
    });

    test("ping ok but identify starved is the UI livelock signature", () => {
        expect(classifyCmuxHealth({ appRunning: true, pingOk: true, identifyOk: false })).toBe("ui-starved");
    });

    test("dead socket with a running app is socket-dead", () => {
        expect(classifyCmuxHealth({ appRunning: true, pingOk: false, identifyOk: false })).toBe("socket-dead");
    });

    test("dead socket without an app process is not-running", () => {
        expect(classifyCmuxHealth({ appRunning: false, pingOk: false, identifyOk: false })).toBe("not-running");
    });
});
