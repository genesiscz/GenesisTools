import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryAnalyzer, parseSwapusage, parseVmStat } from "@app/doctor/analyzers/memory";
import { analysisDirFor } from "@app/doctor/lib/paths";
import type { EngineEvent } from "@app/doctor/lib/types";

const FIXTURES = join(import.meta.dir, "fixtures");
const RUN_IDS: string[] = [];

afterEach(() => {
    for (const runId of RUN_IDS.splice(0)) {
        rmSync(analysisDirFor(runId), { recursive: true, force: true });
    }
});

describe("parseVmStat", () => {
    it("parses Apple Silicon 16k page size", () => {
        const raw = readFileSync(join(FIXTURES, "vm_stat-apple-silicon.txt"), "utf8");
        const parsed = parseVmStat(raw);
        expect(parsed.pageSize).toBe(16384);
        expect(parsed.free).toBe(438004);
        expect(parsed.active).toBe(2203298);
        expect(parsed.wired).toBe(889532);
        expect(parsed.compressed).toBe(405893);
    });

    it("parses Intel 4k page size", () => {
        const raw = readFileSync(join(FIXTURES, "vm_stat-intel.txt"), "utf8");
        const parsed = parseVmStat(raw);
        expect(parsed.pageSize).toBe(4096);
        expect(parsed.free).toBe(50000);
    });

    it("computes bytes using parsed page size", () => {
        const raw = readFileSync(join(FIXTURES, "vm_stat-apple-silicon.txt"), "utf8");
        const parsed = parseVmStat(raw);
        expect(parsed.freeBytes).toBe(438004 * 16384);
        expect(parsed.wiredBytes).toBe(889532 * 16384);
    });
});

describe("parseSwapusage", () => {
    it("parses sysctl vm.swapusage output", () => {
        const raw = "vm.swapusage: total = 56320.00M  used = 54686.50M  free = 1633.50M  (encrypted)";
        const parsed = parseSwapusage(raw);
        expect(parsed.totalBytes).toBe(Math.round(56320 * 1024 * 1024));
        expect(parsed.usedBytes).toBe(Math.round(54686.5 * 1024 * 1024));
        expect(parsed.freeBytes).toBe(Math.round(1633.5 * 1024 * 1024));
        expect(parsed.encrypted).toBe(true);
    });

    it("handles zero swap", () => {
        const raw = "vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M";
        const parsed = parseSwapusage(raw);
        expect(parsed.totalBytes).toBe(0);
        expect(parsed.encrypted).toBe(false);
    });
});

describe("MemoryAnalyzer smoke", () => {
    it("runs against real machine without throwing", async () => {
        const analyzer = new MemoryAnalyzer();
        const events: EngineEvent[] = [];
        const runId = `doctor-memory-test-${crypto.randomUUID()}`;
        RUN_IDS.push(runId);
        const result = await analyzer.analyze({
            runId,
            opts: { thorough: false, fresh: true, dryRun: true },
            emit: (event) => events.push(event),
        });
        expect(result.error).toBeNull();
        expect(result.findings.length).toBeGreaterThan(0);
        expect(result.findings.some((finding) => finding.id === "mem-pressure")).toBe(true);
    });
});
