import {
    buildSessionReport,
    SESSIONS_REPORT_SCHEMA,
    type SessionReport,
} from "@genesiscz/utils/agent-sessions/analysis/report";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import type { ResolvedTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { formatTokens } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import pc from "picocolors";

function usd(value: number | null): string {
    return value === null ? pc.yellow("unpriced") : `$${value.toFixed(2)}`;
}

function renderReport(session: ResolvedTranscript, report: SessionReport): void {
    const o = report.overview;
    renderCliHeader(
        `Session ${session.sessionId.slice(0, 8)}`,
        `${session.provider} · ${o.calls} calls over ${o.durationMinutes} min · ${o.compactions ?? "?"} compactions`
    );
    out.println(
        `cost ${usd(report.cost.totalUsd)} (main ${usd(report.cost.mainUsd)}, sub-agents ${usd(report.cost.subagentUsd)}) · without cache ${usd(report.cost.noCacheUsd)}, saved ${usd(report.cost.savingsUsd)}`
    );
    out.println(
        `tokens in ${formatTokens(report.tokens.input)} · cache read ${formatTokens(report.tokens.cacheRead)} · write ${formatTokens(report.tokens.cacheWrite)} · out ${formatTokens(report.tokens.output)} · hit ${report.cache.hitPercent?.toFixed(0) ?? "?"}% · quota weight ${formatTokens(report.quotaWeight)}`
    );

    if (report.cost.unpricedModels.length > 0) {
        out.println(
            pc.yellow(`no known rate for ${report.cost.unpricedModels.join(", ")}: those calls are not in the dollars`)
        );
    }

    const models = createBoxTable(["MODEL", "CALLS", "IN", "CACHE READ", "CACHE WRITE", "OUT", "COST"]);

    for (const model of report.models) {
        models.push([
            model.model,
            String(model.calls),
            formatTokens(model.input),
            formatTokens(model.cacheRead),
            formatTokens(model.cacheWrite),
            formatTokens(model.output),
            usd(model.costUsd),
        ]);
    }

    out.println(models.toString());
    const calls = createBoxTable(["#", "WHEN", "MODEL", "CONTEXT", "OUT", "COST", "WHY"]);

    for (const call of report.topCalls) {
        calls.push([
            String(call.index),
            new Date(call.t).toLocaleString(),
            call.model,
            formatTokens(call.context),
            formatTokens(call.output),
            usd(call.costUsd),
            call.tags.join(", "),
        ]);
    }

    out.println(calls.toString());

    for (const loss of report.losses.slice(0, 5)) {
        out.println(`cache lost at call ${loss.call} (${loss.cause}): ${loss.reason}`);
    }

    for (const [fact, reason] of Object.entries(report.unsupported)) {
        out.println(pc.dim(`${fact}: ${reason}`));
    }
}

/** Reads the session's analysis facts through its reader and prints the report, or its JSON. */
export async function printSessionReport(
    session: ResolvedTranscript,
    options: { top: number; json?: boolean }
): Promise<void> {
    const analysis = resolveHistoryProvider(session.provider).reader.analysis;
    const [calls, compactions] = await Promise.all([
        analysis.callTrace(session.filePath),
        analysis.compactions(session.filePath),
    ]);
    const report = buildSessionReport({ calls, compactions, top: options.top, agent: session.provider });
    logger.debug(
        { session: session.sessionId, file: session.filePath, calls: report.overview.calls },
        "[ai-sessions] report"
    );

    if (options.json) {
        out.result({ schema: SESSIONS_REPORT_SCHEMA, session, report });
        return;
    }

    renderReport(session, report);
}
