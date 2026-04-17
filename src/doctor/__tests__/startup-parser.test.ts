import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLaunchctlList, parsePmsetAssertions } from "@app/doctor/analyzers/startup";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("parsePmsetAssertions", () => {
    it("finds process-level assertions", () => {
        const raw = readFileSync(join(FIXTURES, "pmset-assertions.txt"), "utf8");
        const items = parsePmsetAssertions(raw);
        const caffeinate = items.find((item) => item.processName === "caffeinate");

        expect(items.length).toBeGreaterThan(0);
        expect(caffeinate?.kind).toBe("PreventUserIdleSystemSleep");
        expect(caffeinate?.pid).toBe(97893);
    });
});

describe("parseLaunchctlList", () => {
    it("parses tab-separated launchctl output", () => {
        const raw = ["PID\tStatus\tLabel", "-\t0\tcom.example.ok", "123\t-9\tcom.example.broken"].join("\n");
        const items = parseLaunchctlList(raw);

        expect(items).toContainEqual({ pid: null, status: 0, label: "com.example.ok" });
        expect(items).toContainEqual({ pid: 123, status: -9, label: "com.example.broken" });
    });
});
