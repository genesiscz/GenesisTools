import { formatDuration } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import { detectDuplicateTools, type ServerTools } from "./duplicates";
import type { DoctorReport, NormalizedServer, ProbeResult, Status } from "./types";

export interface ClassifyInput {
    startedAt: number;
    finishedAt: number | null;
    error: string | null;
    slowThresholdMs: number;
    timeoutMs: number;
}

export interface Classification {
    status: Status;
    latencyMs: number | null;
}

export function classifyResult(input: ClassifyInput): Classification {
    if (input.error) {
        const lower = input.error.toLowerCase();
        const isTimeout = lower.includes("timeout") || lower.includes("timed out");
        if (isTimeout && input.finishedAt === null) {
            return { status: "timeout", latencyMs: null };
        }

        const latency = input.finishedAt === null ? null : input.finishedAt - input.startedAt;
        return { status: "error", latencyMs: latency };
    }

    if (input.finishedAt === null) {
        return { status: "timeout", latencyMs: null };
    }

    const latencyMs = input.finishedAt - input.startedAt;
    if (latencyMs > input.slowThresholdMs) {
        return { status: "slow", latencyMs };
    }

    return { status: "ok", latencyMs };
}

function latencyCell(result: ProbeResult): string {
    if (result.latencyMs === null) {
        return "—";
    }

    return formatDuration(result.latencyMs, "ms");
}

function noteCell(result: ProbeResult, slowThresholdMs: number): string {
    if (result.status === "error" && result.error) {
        return result.error;
    }

    if (result.status === "slow") {
        return `> ${slowThresholdMs}ms threshold`;
    }

    if (result.status === "timeout") {
        return "no handshake before timeout";
    }

    return "—";
}

export function buildReport(results: ProbeResult[]): DoctorReport {
    const serverTools: ServerTools[] = results
        .filter((r) => r.status === "ok" || r.status === "slow")
        .map((r) => ({ name: r.name, tools: r.tools }));
    const duplicates = detectDuplicateTools(serverTools);

    const count = (s: Status): number => results.filter((r) => r.status === s).length;
    const summary = {
        total: results.length,
        ok: count("ok"),
        slow: count("slow"),
        timeout: count("timeout"),
        error: count("error") + count("invalid"),
        duplicateTools: duplicates.length,
    };

    return { servers: results, duplicates, summary };
}

export function formatHealthTable(report: DoctorReport, slowThresholdMs = 3_000): string {
    const headers = ["SERVER", "SOURCE", "STATUS", "LATENCY", "TOOLS", "NOTE"];
    const rows = report.servers.map((r) => [
        r.name,
        r.source,
        r.status,
        latencyCell(r),
        r.status === "ok" || r.status === "slow" ? String(r.toolCount) : "—",
        noteCell(r, slowThresholdMs),
    ]);

    const lines: string[] = [];
    const s = report.summary;
    lines.push(
        `mcp-doctor — ${s.total} servers (${s.ok} ok · ${s.slow} slow · ${s.timeout} timeout · ${s.error} error)`
    );
    lines.push("");
    lines.push(formatTable(rows, headers));

    if (report.duplicates.length > 0) {
        lines.push("");
        lines.push("Duplicate tool names across servers:");
        for (const dup of report.duplicates) {
            lines.push(`  ${dup.tool}  →  ${dup.servers.join(", ")}`);
        }
    }

    return lines.join("\n");
}

export function formatConfigTable(servers: NormalizedServer[]): string {
    const headers = ["SERVER", "TRANSPORT", "SOURCE", "TARGET"];
    const rows = servers.map((s) => {
        let target = "";
        if ("invalidReason" in s) {
            target = `(invalid: ${s.invalidReason})`;
        } else if (s.transport === "stdio") {
            target = [s.command, ...s.args].join(" ");
        } else {
            target = s.url;
        }

        return [s.name, s.transport, s.source, target];
    });

    return `mcp-doctor — ${servers.length} servers configured (no probe)\n\n${formatTable(rows, headers)}`;
}
