import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTree, parsePsOutput, readProcessRecords } from "@app/doctor/analyzers/processes";
import * as processOs from "@genesiscz/utils/process/os";
import * as ps from "@genesiscz/utils/process/ps";

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
it("readProcessRecords uses one Windows snapshot per CPU sample", async () => {
    const platform = spyOn(processOs, "processPlatform").mockReturnValue("win32");
    const capture = spyOn(ps, "captureSync").mockReturnValue({
        stderr: "",
        status: 0,
        stdout: '[{"ProcessId":81001,"Name":"worker.exe","CommandLine":"worker.exe --job fixture","WorkingSetSize":1024},{"ProcessId":81002,"Name":"helper.exe","WorkingSetSize":2048}]',
    });
    try {
        for (let sample = 1; sample <= 2; sample++) {
            const rows = await readProcessRecords();
            expect(rows.map((row) => row.comm)).toEqual(["worker.exe", "helper.exe"]);
            expect(rows[0].command).toBe("worker.exe --job fixture");
            expect(rows[1].rssBytes).toBe(2048);
            expect(capture).toHaveBeenCalledTimes(sample);
        }
    } finally {
        capture.mockRestore();
        platform.mockRestore();
    }
});
