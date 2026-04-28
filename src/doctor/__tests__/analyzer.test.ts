import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { analysisDirFor } from "@app/doctor/lib/paths";
import type { AnalyzerCategory, AnalyzerContext, EngineEvent, Finding } from "@app/doctor/lib/types";

let runId: string;

class StubAnalyzer extends Analyzer {
    readonly id = "stub";
    readonly name = "Stub";
    readonly icon = "S";
    readonly category: AnalyzerCategory = "disk";

    protected async *run(_: AnalyzerContext): AsyncIterable<Finding> {
        yield {
            id: "f1",
            analyzerId: this.id,
            title: "item",
            severity: "safe",
            actions: [],
            reclaimableBytes: 10,
        };
    }
}

class ErrorAnalyzer extends Analyzer {
    readonly id = "err";
    readonly name = "Err";
    readonly icon = "E";
    readonly category: AnalyzerCategory = "disk";
    readonly cacheTtlMs = 0;

    protected async *run(_: AnalyzerContext): AsyncIterable<Finding> {
        if (Date.now() >= 0) {
            throw new Error("boom");
        }
        yield {
            id: "unreachable",
            analyzerId: this.id,
            title: "unreachable",
            severity: "safe",
            actions: [],
        };
    }
}

beforeEach(() => {
    runId = `doctor-analyzer-test-${crypto.randomUUID()}`;
});

afterEach(() => {
    rmSync(analysisDirFor(runId), { recursive: true, force: true });
});

function ctx(events: EngineEvent[]): AnalyzerContext {
    return {
        runId,
        opts: { thorough: false, fresh: true, dryRun: true },
        emit: (event) => events.push(event),
    };
}

describe("Analyzer base class", () => {
    it("streams findings and emits events", async () => {
        const events: EngineEvent[] = [];
        const analyzer = new StubAnalyzer();
        const result = await analyzer.analyze(ctx(events));
        expect(result.findings).toHaveLength(1);
        expect(result.error).toBeNull();
        expect(events.some((event) => event.type === "finding")).toBe(true);
    });

    it("captures errors without throwing", async () => {
        const events: EngineEvent[] = [];
        const analyzer = new ErrorAnalyzer();
        const result = await analyzer.analyze(ctx(events));
        expect(result.error).toBeInstanceOf(Error);
    });

    it("records durationMs", async () => {
        const analyzer = new StubAnalyzer();
        const result = await analyzer.analyze(ctx([]));
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
});
