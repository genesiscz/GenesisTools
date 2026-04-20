import logger from "@app/logger";
import { readCache, writeCache } from "./cache";
import { writeAnalysisLog } from "./history";
import type { AnalyzerCategory, AnalyzerContext, AnalyzerResult, Finding } from "./types";

export abstract class Analyzer {
    abstract readonly id: string;
    abstract readonly name: string;
    abstract readonly icon: string;
    abstract readonly category: AnalyzerCategory;
    readonly cacheTtlMs: number = 0;

    protected abstract run(ctx: AnalyzerContext): AsyncIterable<Finding>;

    async analyze(ctx: AnalyzerContext): Promise<AnalyzerResult> {
        this.logStart({ action: "analyze" });
        const startedAt = Date.now();
        const findings: Finding[] = [];
        let error: AnalyzerResult["error"] = null;

        ctx.emit({ type: "analyzer-start", analyzerId: this.id, startedAt: new Date().toISOString() });
        ctx.emit({
            type: "progress",
            analyzerId: this.id,
            phase: "scanning",
            currentItem: "starting…",
            findingsCount: 0,
        });

        if (this.cacheTtlMs > 0 && !ctx.opts.fresh) {
            const cached = await readCache(this.id, this.cacheTtlMs);

            if (cached) {
                for (const finding of cached.findings) {
                    ctx.emit({ type: "finding", analyzerId: this.id, finding, fromCache: true });
                }

                const durationMs = Date.now() - startedAt;
                ctx.emit({
                    type: "analyzer-done",
                    analyzerId: this.id,
                    durationMs,
                    findingsCount: cached.findings.length,
                });
                this.logEnd({ action: "analyze", durationMs, count: cached.findings.length });
                return { ...cached, fromCache: true, durationMs };
            }
        }

        try {
            for await (const finding of this.run(ctx)) {
                findings.push(finding);
                ctx.emit({ type: "finding", analyzerId: this.id, finding });
            }
        } catch (err) {
            error = err;
            logger.error({ analyzer: this.id, err }, `[${this.id}] run threw`);
        }

        const durationMs = Date.now() - startedAt;
        const result: AnalyzerResult = {
            analyzerId: this.id,
            findings,
            durationMs,
            error,
            fromCache: false,
            timestamp: new Date().toISOString(),
        };

        if (!error && this.cacheTtlMs > 0) {
            await writeCache(this.id, result);
        }

        await writeAnalysisLog(ctx.runId, this.id, result);

        ctx.emit({ type: "analyzer-done", analyzerId: this.id, durationMs, findingsCount: findings.length, error });
        this.logEnd({ action: "analyze", durationMs, count: findings.length });
        return result;
    }

    protected logStart(meta: { action: string }): void {
        logger.debug({ analyzer: this.id, ...meta }, `[${this.id}] ${meta.action} started`);
    }

    protected logEnd(meta: { action: string; durationMs: number; count?: number }): void {
        logger.debug(
            { analyzer: this.id, ...meta },
            `[${this.id}] ${meta.action} done (${meta.durationMs}ms, ${meta.count ?? 0} findings)`
        );
    }
}
