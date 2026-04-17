import { Analyzer } from "@app/doctor/lib/analyzer";
import type { AnalyzerCategory, AnalyzerContext, Finding } from "@app/doctor/lib/types";

export class StubAnalyzer extends Analyzer {
    readonly id = "stub";
    readonly name = "Stub";
    readonly icon = "*";
    readonly category: AnalyzerCategory = "disk";

    protected async *run(ctx: AnalyzerContext): AsyncIterable<Finding> {
        for (let index = 0; index < 3; index++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            ctx.emit({
                type: "progress",
                analyzerId: this.id,
                phase: "scanning",
                percent: ((index + 1) / 3) * 100,
                findingsCount: index,
            });

            yield {
                id: `stub-${index}`,
                analyzerId: this.id,
                title: `Stub finding ${index}`,
                severity: index === 2 ? "dangerous" : "safe",
                reclaimableBytes: 1024 * 1024 * (index + 1),
                actions: [
                    {
                        id: "noop",
                        label: "Do nothing",
                        confirm: index === 2 ? "typed" : "none",
                        confirmPhrase: index === 2 ? "DELETE" : undefined,
                        execute: async (_ctx, finding) => ({
                            findingId: finding.id,
                            actionId: "noop",
                            status: "ok",
                            actualReclaimedBytes: finding.reclaimableBytes,
                        }),
                    },
                ],
            };
        }
    }
}
