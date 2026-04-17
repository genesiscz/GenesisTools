import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTree, parsePsOutput } from "@app/doctor/analyzers/processes";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("parsePsOutput", () => {
    it("parses the fixture into process records", () => {
        const raw = readFileSync(join(FIXTURES, "ps-axo-snapshot.txt"), "utf8");
        const processes = parsePsOutput(raw);
        expect(processes.length).toBeGreaterThan(5);

        const cpuHog = processes.find((process) => process.pid === 5000);
        expect(cpuHog?.cpu).toBeCloseTo(99.5);
        expect(cpuHog?.comm).toBe("node");
    });

    it("flags zombie processes", () => {
        const raw = readFileSync(join(FIXTURES, "ps-axo-snapshot.txt"), "utf8");
        const processes = parsePsOutput(raw);
        const zombie = processes.find((process) => process.pid === 6000);
        expect(zombie?.isZombie).toBe(true);
    });
});

describe("buildTree", () => {
    it("builds parent to children map", () => {
        const raw = readFileSync(join(FIXTURES, "ps-axo-snapshot.txt"), "utf8");
        const processes = parsePsOutput(raw);
        const tree = buildTree(processes);
        const braveChildren = tree.get(7000);
        expect(braveChildren?.map((child) => child.pid)).toContain(7100);
    });
});
