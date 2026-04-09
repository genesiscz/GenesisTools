import type { ProviderFetchLogRow, ProviderHealthSummary } from "@app/Internal/commands/reas/lib/store";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { Activity, AlertTriangle, CheckCircle2, Clock, Database, XCircle } from "lucide-react";
import { fmtDateTime } from "../../lib/format";

interface ProviderHealthDashboardProps {
    health: ProviderHealthSummary[];
    recentLog: ProviderFetchLogRow[];
}

function getSuccessRateColor(rate: number): string {
    if (rate >= 90) {
        return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
    }

    if (rate >= 70) {
        return "border-amber-500/30 bg-amber-500/10 text-amber-300";
    }

    return "border-red-500/30 bg-red-500/10 text-red-300";
}

function getSuccessRateBorderColor(rate: number): string {
    if (rate >= 90) {
        return "border-b-emerald-500/60";
    }

    if (rate >= 70) {
        return "border-b-amber-500/60";
    }

    return "border-b-red-500/60";
}

function getStatusIcon(status: string) {
    if (status === "success") {
        return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
    }

    if (status === "error") {
        return <XCircle className="h-3.5 w-3.5 text-red-400" />;
    }

    return <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />;
}

function getStatusBadgeClass(status: string): string {
    if (status === "success") {
        return "border-emerald-500/20 bg-emerald-500/10 text-emerald-300";
    }

    if (status === "error") {
        return "border-red-500/20 bg-red-500/10 text-red-300";
    }

    return "border-amber-500/20 bg-amber-500/10 text-amber-300";
}

function formatDuration(ms: number | null): string {
    if (ms === null) {
        return "-";
    }

    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }

    return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(value: string | null): string {
    if (!value) {
        return "Never";
    }

    return fmtDateTime(value, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function ProviderHealthDashboard({ health, recentLog }: ProviderHealthDashboardProps) {
    return (
        <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {health.map((provider) => (
                    <Card
                        key={provider.provider}
                        className={cn(
                            "border-white/5 border-b-2 bg-white/[0.02] transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/[0.04]",
                            getSuccessRateBorderColor(provider.successRate)
                        )}
                    >
                        <CardHeader className="pb-2">
                            <div className="flex items-center justify-between gap-3">
                                <CardTitle className="text-sm font-mono uppercase tracking-[0.2em] text-white">
                                    {provider.provider}
                                </CardTitle>
                                <Badge
                                    className={cn(
                                        "border font-mono text-[10px] uppercase tracking-[0.2em]",
                                        getSuccessRateColor(provider.successRate)
                                    )}
                                >
                                    {provider.successRate.toFixed(0)}%
                                </Badge>
                            </div>
                            <CardDescription className="font-mono text-[11px] text-slate-500">
                                {provider.totalFetches} fetches in window
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                                <div className="rounded-lg bg-slate-950/40 px-2.5 py-2">
                                    <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-slate-500">
                                        Avg count
                                    </div>
                                    <div className="mt-0.5 text-sm font-mono text-white">
                                        {Math.round(provider.avgListingCount)}
                                    </div>
                                </div>
                                <div className="rounded-lg bg-slate-950/40 px-2.5 py-2">
                                    <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-slate-500">
                                        Avg speed
                                    </div>
                                    <div className="mt-0.5 text-sm font-mono text-white">
                                        {formatDuration(provider.avgDurationMs)}
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                                    <div
                                        className={cn(
                                            "h-full rounded-full transition-all duration-500",
                                            provider.successRate >= 90
                                                ? "bg-emerald-500/70"
                                                : provider.successRate >= 70
                                                  ? "bg-amber-500/70"
                                                  : "bg-red-500/70"
                                        )}
                                        style={{ width: `${provider.successRate}%` }}
                                    />
                                </div>
                            </div>
                            <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
                                <span className="flex items-center gap-1.5">
                                    <Clock className="h-3 w-3" />
                                    {formatTimestamp(provider.lastFetchedAt)}
                                </span>
                                {provider.errorCount > 0 ? (
                                    <span className="text-red-400">{provider.errorCount} errors</span>
                                ) : null}
                            </div>
                            {provider.lastError ? (
                                <div
                                    title={provider.lastError}
                                    className="rounded-md border border-red-500/10 bg-red-500/5 px-2 py-1.5 text-[11px] font-mono leading-4 text-red-300 line-clamp-2"
                                >
                                    {provider.lastError}
                                </div>
                            ) : null}
                        </CardContent>
                    </Card>
                ))}
                {health.length === 0 ? (
                    <Card className="border-white/5 bg-white/[0.02] sm:col-span-2 lg:col-span-3 xl:col-span-4">
                        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                            <Database className="h-8 w-8 text-slate-600" />
                            <p className="font-mono text-sm text-slate-400">
                                No provider health data yet. Run an analysis to start logging.
                            </p>
                        </CardContent>
                    </Card>
                ) : null}
            </div>

            <Card className="border-white/5 bg-white/[0.02]">
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                        <Activity className="h-4 w-4 text-cyan-300" />
                        Recent fetch log
                    </CardTitle>
                    <CardDescription className="font-mono text-xs text-slate-500">
                        Last {recentLog.length} provider fetch operations across all districts.
                    </CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs font-mono">
                            <thead>
                                <tr className="border-b border-white/5 text-left text-[10px] uppercase tracking-[0.2em] text-slate-500">
                                    <th className="px-4 py-2">Timestamp</th>
                                    <th className="px-4 py-2">Provider</th>
                                    <th className="px-4 py-2">Contract</th>
                                    <th className="px-4 py-2">District</th>
                                    <th className="px-4 py-2">Status</th>
                                    <th className="px-4 py-2 text-right">Count</th>
                                    <th className="px-4 py-2">Error</th>
                                </tr>
                            </thead>
                            <tbody>
                                {recentLog.map((row) => (
                                    <tr
                                        key={row.id}
                                        className="border-b border-white/[0.03] transition-colors hover:bg-white/[0.02]"
                                    >
                                        <td className="px-4 py-2 text-slate-400">{formatTimestamp(row.created_at)}</td>
                                        <td className="px-4 py-2 uppercase tracking-[0.15em] text-slate-200">
                                            {row.provider}
                                        </td>
                                        <td className="px-4 py-2 text-slate-500">{row.source_contract}</td>
                                        <td className="px-4 py-2 text-slate-400">{row.district ?? "-"}</td>
                                        <td className="px-4 py-2">
                                            <span className="inline-flex items-center gap-1.5">
                                                {getStatusIcon(row.status)}
                                                <Badge
                                                    className={cn(
                                                        "border font-mono text-[9px] uppercase tracking-[0.2em]",
                                                        getStatusBadgeClass(row.status)
                                                    )}
                                                >
                                                    {row.status}
                                                </Badge>
                                            </span>
                                        </td>
                                        <td className="px-4 py-2 text-right text-white">{row.listing_count}</td>
                                        <td
                                            className="max-w-[240px] truncate px-4 py-2 text-red-300"
                                            title={row.error_message ?? undefined}
                                        >
                                            {row.error_message ?? ""}
                                        </td>
                                    </tr>
                                ))}
                                {recentLog.length === 0 ? (
                                    <tr>
                                        <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                                            No fetch log entries yet.
                                        </td>
                                    </tr>
                                ) : null}
                            </tbody>
                        </table>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
