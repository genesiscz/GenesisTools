import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
    getTopProcessesByRss,
    MemoryAnalyzer,
    parseSwapusage,
    parseVmStat,
    type SwapusageParsed,
    type VmStatParsed,
} from "@app/doctor/analyzers/memory";
import { analysisDirFor } from "@app/doctor/lib/paths";
import type { EngineEvent } from "@app/doctor/lib/types";
import * as processOs from "@genesiscz/utils/process/os";
import * as ps from "@genesiscz/utils/process/ps";

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

    it.skipIf(process.platform !== "darwin")(
        "reports the page counts vm_stat and the swap sysctl show at the same moment",
        async () => {
            const analyzer = new MemoryAnalyzer();
            const runId = `doctor-memory-test-${crypto.randomUUID()}`;
            RUN_IDS.push(runId);
            const result = await analyzer.analyze({
                runId,
                opts: { thorough: false, fresh: true, dryRun: true },
                emit: () => {},
            });
            const vmStat = parseVmStat(spawnSync("vm_stat", [], { encoding: "utf8", env: process.env }).stdout);
            const swap = parseSwapusage(
                spawnSync("sysctl", ["vm.swapusage"], { encoding: "utf8", env: process.env }).stdout
            );
            const pressure = result.findings.find((finding) => finding.id === "mem-pressure");
            const vm = pressure?.metadata?.vm as VmStatParsed | undefined;
            const pages = (parsed: VmStatParsed) =>
                parsed.free + parsed.active + parsed.inactive + parsed.speculative + parsed.wired + parsed.compressed;

            expect(vm?.pageSize).toBe(vmStat.pageSize);
            // Pages move between category counts from one read to the next; their sum barely does.
            expect(Math.abs(pages(vm ?? vmStat) - pages(vmStat))).toBeLessThan(pages(vmStat) * 0.05);
            expect(Math.abs((vm?.wired ?? Number.NaN) - vmStat.wired)).toBeLessThan(vmStat.wired * 0.1);

            const swapFinding = result.findings.find((finding) => finding.id === "mem-swap");

            if (swap.totalBytes === 0) {
                expect(swapFinding).toBeUndefined();
                return;
            }

            const reported = swapFinding?.metadata?.swap as SwapusageParsed | undefined;
            expect(reported?.totalBytes).toBe(swap.totalBytes);
            expect(reported?.encrypted).toBe(swap.encrypted);
            expect(Math.abs((reported?.usedBytes ?? Number.NaN) - swap.usedBytes)).toBeLessThan(256 * 1024 * 1024);
        }
    );
});
it("top RSS processes use one Windows snapshot even when the limit excludes rows", async () => {
    const platform = spyOn(processOs, "processPlatform").mockReturnValue("win32");
    const capture = spyOn(ps, "captureSync").mockReturnValue({
        stderr: "",
        status: 0,
        stdout: '[{"ProcessId":81001,"Name":"worker.exe","CommandLine":"worker.exe --job fixture","WorkingSetSize":1024},{"ProcessId":81002,"Name":"helper.exe","WorkingSetSize":2048}]',
    });
    try {
        const rows = await getTopProcessesByRss(1);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ pid: 81002, comm: "helper.exe", rssBytes: 2048 });
        expect(capture).toHaveBeenCalledTimes(1);
    } finally {
        capture.mockRestore();
        platform.mockRestore();
    }
});
