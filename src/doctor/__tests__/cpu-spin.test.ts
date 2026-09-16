import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import {
    CpuSpinAnalyzer,
    parseCpuTime,
    parseCpuTimeSamples,
    processOwner,
    spinningProcesses,
} from "@app/doctor/analyzers/cpu-spin";
import { analysisDirFor } from "@app/doctor/lib/paths";
import type { AnalyzerContext } from "@app/doctor/lib/types";

const PS_BEFORE = [
    "    1  54:21.10 /sbin/launchd",
    " 2056   8:03.60 /Users/dev/GenesisTools/src/dev-dashboard/index.ts __ui-server",
    "29897   0:10.00 /Users/dev/Applications/GenesisTools.app/Contents/MacOS/GenesisTools --rpc",
    "31843   0:00.44 /Users/dev/.bun/bin/bun run /Users/dev/GenesisTools/src/ai/commands/usage/poll-daemon.ts",
    "40000   1-02:03:04.50 /usr/libexec/logd",
].join("\n");

const PS_AFTER = [
    "    1  54:21.11 /sbin/launchd",
    " 2056   8:03.61 /Users/dev/GenesisTools/src/dev-dashboard/index.ts __ui-server",
    "29897   0:11.20 /Users/dev/Applications/GenesisTools.app/Contents/MacOS/GenesisTools --rpc",
    "31843   0:01.44 /Users/dev/.bun/bin/bun run /Users/dev/GenesisTools/src/ai/commands/usage/poll-daemon.ts",
    "40000   1-02:03:04.50 /usr/libexec/logd",
    "50000   0:02.00 ps -axo pid=,cputime=,command=",
].join("\n");

describe("cpu-spin parsing", () => {
    it("reads every ps cputime shape into milliseconds", () => {
        expect(parseCpuTime("0:00.44")).toBe(440);
        expect(parseCpuTime("8:03.60")).toBe(483_600);
        expect(parseCpuTime("1:02:03.50")).toBe(3_723_500);
        expect(parseCpuTime("1-02:03:04.50")).toBe(93_784_500);
        expect(parseCpuTime("garbage")).toBeNull();
    });

    it("keys samples by pid and keeps the whole command line", () => {
        const samples = parseCpuTimeSamples(PS_BEFORE);
        expect(samples.size).toBe(5);
        expect(samples.get(29897)?.command).toBe(
            "/Users/dev/Applications/GenesisTools.app/Contents/MacOS/GenesisTools --rpc"
        );
        expect(samples.get(40000)?.cpuMs).toBe(93_784_500);
    });
});

describe("spinningProcesses", () => {
    it("reports the delta over the window and ignores idle and newborn processes", () => {
        const found = spinningProcesses(parseCpuTimeSamples(PS_BEFORE), parseCpuTimeSamples(PS_AFTER), 2_000, 25);

        expect(found.map((record) => record.pid)).toEqual([29897, 31843]);
        expect(found[0].percent).toBe(60);
        expect(found[0].deltaMs).toBe(1_200);
        expect(found[1].percent).toBe(50);
    });

    it("does not judge a pid whose command line changed between the samples", () => {
        const before = parseCpuTimeSamples("  77   0:00.00 /bin/old");
        const after = parseCpuTimeSamples("  77   0:02.00 /bin/new");

        expect(spinningProcesses(before, after, 1_000, 25)).toEqual([]);
    });
});

describe("processOwner", () => {
    it("names the two shapes this repo owns", () => {
        expect(processOwner("/Users/dev/Applications/GenesisTools.app/Contents/MacOS/GenesisTools --rpc")).toBe(
            "genesis-face"
        );
        expect(processOwner("/Users/dev/Applications/GenesisTools.app/Contents/MacOS/GenesisTools")).toBe(
            "genesis-face"
        );
        expect(
            processOwner(
                "/Users/dev/Applications/GenesisTools.app/Contents/MacOS/GenesisTools /Users/dev/.bun/bin/bun run x"
            )
        ).toBeNull();
        expect(processOwner("/Users/dev/.bun/bin/bun run /Users/dev/GenesisTools/src/ai/index.ts")).toBe(
            "genesis-tool"
        );
        expect(processOwner("/Users/dev/.genesis-tools/bin/gt-ai /Users/dev/GenesisTools/src/ai/index.ts")).toBe(
            "genesis-tool"
        );
        expect(processOwner("/usr/libexec/logd")).toBeNull();
    });
});

describe("CpuSpinAnalyzer", () => {
    it("catches a planted spin: a child burning one core for the whole window", async () => {
        const spinner = Bun.spawn(["bun", "-e", "const end = Date.now() + 4000; while (Date.now() < end) {}"], {
            stdout: "ignore",
            stderr: "ignore",
            env: process.env,
        });

        try {
            const analyzer = new CpuSpinAnalyzer({ windowMs: 1_000, thresholdPercent: 50 });
            const events: unknown[] = [];
            const ctx: AnalyzerContext = {
                runId: "test",
                opts: { thorough: false, fresh: true, dryRun: true },
                emit: (event) => {
                    events.push(event);
                },
            };
            // Let the child get past bun's own startup before the first sample.
            await Bun.sleep(500);

            const { findings } = await analyzer.analyze(ctx);

            const planted = findings.find((finding) => finding.metadata?.pid === spinner.pid);
            expect(planted).toBeDefined();
            expect(planted?.severity).toBe("cautious");
            expect(planted?.actions.map((action) => action.id)).toEqual(["kill"]);
            expect(planted?.metadata?.owner).toBeNull();
        } finally {
            spinner.kill();
            await spinner.exited;
            rmSync(analysisDirFor("test"), { recursive: true, force: true });
        }
    });
});
