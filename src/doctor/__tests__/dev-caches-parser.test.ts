import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDockerSystemDfJson, parseSimctlJson } from "@app/doctor/analyzers/dev-caches";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("parseSimctlJson", () => {
    it("parses devices into a flat array with runtime suffix", () => {
        const raw = readFileSync(join(FIXTURES, "simctl-devices.json"), "utf8");
        const devices = parseSimctlJson(raw);

        expect(devices.length).toBe(6);
        expect(devices[0].runtime).toContain("iOS");
        expect(devices[0].udid).toMatch(/[A-F0-9-]+/i);
    });

    it("returns [] on invalid JSON", () => {
        expect(parseSimctlJson("not json")).toEqual([]);
    });
});

describe("parseDockerSystemDfJson", () => {
    it("parses docker system df JSON objects split by line", () => {
        const raw = [
            '{"Type":"Images","TotalCount":"12","Active":"3","Size":"18.2GB","Reclaimable":"11.1GB (61%)"}',
            '{"Type":"Local Volumes","TotalCount":"4","Active":"1","Size":"2.5GB","Reclaimable":"2.0GB (80%)"}',
        ].join("\n");

        const summary = parseDockerSystemDfJson(raw);
        expect(summary).toContainEqual({
            type: "Images",
            totalCount: 12,
            active: 3,
            size: "18.2GB",
            reclaimable: "11.1GB (61%)",
        });
    });
});
