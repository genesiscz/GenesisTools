import { formatCost, formatTokens } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import asciichart from "asciichart";
import pc from "picocolors";
import type { Report } from "./types";

function pct(n: number): string {
    return `${(n * 100).toFixed(1)}%`;
}

function modelLabel(model: string, priced: boolean): string {
    return priced ? model : `${model} ${pc.dim("(unpriced)")}`;
}

function trend(report: Report): string {
    const series = report.days.map((d) => d.cost);
    if (series.length < 2) {
        return "";
    }

    // padding must be wide enough for the longest left-axis label or asciichart
    // slices leading digits (a $1358 day would render as "358"). format keeps
    // the axis to 2 decimals and a fixed width.
    const chart = asciichart.plot(series, {
        height: 6,
        padding: "         ",
        format: (v: number) => `$${v.toFixed(2)}`.padStart(9),
    });
    return `\nDAILY TREND (spend $)\n${chart}\n  ${report.days.map((d) => d.day.slice(5)).join("  ")}`;
}

export function renderSummary(report: Report): string {
    const t = report.total;
    const header = [
        pc.bold("ai-spend — Claude Code token & cost analytics"),
        pc.dim(
            `window: ${report.windowStartDay} → ${report.windowEndDay} (UTC)  •  ${report.projectCount} projects  •  ${report.sessionCount} sessions`
        ),
        "",
        "TOTAL",
        `  spend          ${formatCost(t.cost)}`,
        `  tokens         ${formatTokens(t.totalTokens)}  (in ${formatTokens(t.tokens.input)} · out ${formatTokens(
            t.tokens.output
        )} · cache-write ${formatTokens(t.tokens.cacheWrite)} · cache-read ${formatTokens(t.tokens.cacheRead)})`,
        `  cache-hit rate ${pct(t.cacheHitRate)}`,
    ].join("\n");

    const modelTable = formatTable(
        report.models.map((m) => [
            modelLabel(m.model, m.priced),
            formatCost(m.cost),
            `${formatTokens(m.totalTokens)} tok`,
        ]),
        ["MODEL", "COST", "TOKENS"]
    );

    const projectTable = formatTable(
        report.projects.map((p) => [p.project, formatCost(p.cost), `${p.sessions} sessions`]),
        ["PROJECT", "COST", "SESSIONS"]
    );

    const sessionTable = formatTable(
        report.sessions.map((s) => [
            s.sessionId.slice(0, 8),
            s.project,
            formatCost(s.cost),
            `${formatTokens(s.totalTokens)} tok`,
            s.lastDay,
        ]),
        ["SESSION", "PROJECT", "COST", "TOKENS", "DAY"]
    );

    return [
        header,
        trend(report),
        `\nBY MODEL\n${modelTable}`,
        `\nTOP PROJECTS\n${projectTable}`,
        `\nTOP SESSIONS\n${sessionTable}`,
    ].join("\n");
}

export function renderSessions(report: Report): string {
    const table = formatTable(
        report.sessions.map((s) => [
            s.sessionId.slice(0, 8),
            s.project,
            formatCost(s.cost),
            `${formatTokens(s.totalTokens)} tok`,
            s.lastDay,
        ]),
        ["SESSION", "PROJECT", "COST", "TOKENS", "DAY"]
    );
    return `Most expensive sessions (${report.windowStartDay} → ${report.windowEndDay} UTC)\n${table}`;
}

export function renderToday(report: Report): string {
    const t = report.total;
    return [
        pc.bold(`Today (${report.windowEndDay} UTC)`),
        `  spend          ${formatCost(t.cost)}`,
        `  tokens         ${formatTokens(t.totalTokens)}`,
        `  cache-hit rate ${pct(t.cacheHitRate)}`,
    ].join("\n");
}
