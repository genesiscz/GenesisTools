import { EventEmitter } from "node:events";
import pLimit from "p-limit";
import type { Analyzer } from "./analyzer";
import type { AnalyzerResult, EngineEvent } from "./types";

export interface EngineRunOpts {
    concurrency: number;
    thorough: boolean;
    fresh: boolean;
    runId: string;
    dryRun: boolean;
}

export class Engine extends EventEmitter {
    async run(analyzers: Analyzer[], opts: EngineRunOpts): Promise<Map<string, AnalyzerResult>> {
        const startedAt = Date.now();
        const limit = pLimit(opts.concurrency);
        const results = new Map<string, AnalyzerResult>();

        const emit = (event: EngineEvent): void => {
            this.emit("event", event);
        };

        await Promise.all(
            analyzers.map((analyzer) =>
                limit(async () => {
                    const result = await analyzer.analyze({
                        runId: opts.runId,
                        opts: { thorough: opts.thorough, fresh: opts.fresh, dryRun: opts.dryRun },
                        emit,
                    });
                    results.set(analyzer.id, result);
                })
            )
        );

        emit({ type: "all-done", totalDurationMs: Date.now() - startedAt });
        return results;
    }
}
