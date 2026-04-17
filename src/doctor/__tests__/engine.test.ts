import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { Engine } from "@app/doctor/lib/engine";
import { analysisDirFor } from "@app/doctor/lib/paths";
import type { AnalyzerCategory, AnalyzerContext, EngineEvent, Finding } from "@app/doctor/lib/types";

let runId: string;

class FastAnalyzer extends Analyzer {
    readonly id = "fast";
    readonly name = "Fast";
    readonly icon = "F";
    readonly category: AnalyzerCategory = "disk";

    protected async *run(_: AnalyzerContext): AsyncIterable<Finding> {
        yield { id: "f1", analyzerId: this.id, title: "fast-finding", severity: "safe", actions: [] };
    }
}

class SlowAnalyzer extends Analyzer {
    readonly id = "slow";
    readonly name = "Slow";
    readonly icon = "S";
    readonly category: AnalyzerCategory = "memory";

    protected async *run(_: AnalyzerContext): AsyncIterable<Finding> {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield { id: "s1", analyzerId: this.id, title: "slow-finding", severity: "safe", actions: [] };
    }
}

beforeEach(() => {
    runId = `doctor-engine-test-${crypto.randomUUID()}`;
});

afterEach(() => {
    rmSync(analysisDirFor(runId), { recursive: true, force: true });
});

describe("Engine", () => {
    it("runs analyzers in parallel and returns a result map", async () => {
        const engine = new Engine();
        const events: EngineEvent[] = [];
        engine.on("event", (event) => events.push(event));

        const results = await engine.run([new FastAnalyzer(), new SlowAnalyzer()], {
            concurrency: 2,
            thorough: false,
            fresh: true,
            runId,
            dryRun: true,
        });

        expect(results.size).toBe(2);
        expect(results.get("fast")?.findings).toHaveLength(1);
        expect(results.get("slow")?.findings).toHaveLength(1);
        expect(events.some((event) => event.type === "all-done")).toBe(true);
    });
});
