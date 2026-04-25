import type { Analyzer } from "@app/doctor/lib/analyzer";
import { Engine } from "@app/doctor/lib/engine";
import type { Finding } from "@app/doctor/lib/types";
import { SafeJSON } from "@app/utils/json";

export interface JsonRunOpts {
    analyzers: Analyzer[];
    runId: string;
    only?: string[];
    thorough: boolean;
    fresh: boolean;
    dryRun: boolean;
}

export async function runJson(opts: JsonRunOpts): Promise<void> {
    const selected =
        opts.only && opts.only.length > 0 ? opts.analyzers.filter((a) => opts.only!.includes(a.id)) : opts.analyzers;
    const engine = new Engine();
    const findings: Finding[] = [];
    const errors: Array<{ analyzerId: string; error: string }> = [];

    engine.on("event", (event) => {
        if (event.type === "finding") {
            findings.push(event.finding);
        }

        if (event.type === "analyzer-done" && event.error) {
            errors.push({ analyzerId: event.analyzerId, error: String(event.error) });
        }
    });

    const startedAt = new Date();
    await engine.run(selected, {
        concurrency: 4,
        thorough: opts.thorough,
        fresh: opts.fresh,
        runId: opts.runId,
        dryRun: opts.dryRun,
    });

    const output = {
        runId: opts.runId,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        analyzers: selected.map((a) => a.id),
        findings: findings.map((f) => ({
            id: f.id,
            analyzerId: f.analyzerId,
            title: f.title,
            detail: f.detail,
            severity: f.severity,
            reclaimableBytes: f.reclaimableBytes,
            blacklistReason: f.blacklistReason,
            availableActionIds: f.actions.map((a) => a.id),
            metadata: f.metadata,
        })),
        errors,
    };

    console.log(SafeJSON.stringify(output, null, 2));
}
