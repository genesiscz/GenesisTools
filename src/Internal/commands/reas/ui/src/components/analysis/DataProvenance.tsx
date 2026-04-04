import type { DashboardProvenance, DashboardSectionProvenance } from "@app/Internal/commands/reas/lib/api-export";
import type { ProviderFetchSummary } from "@app/Internal/commands/reas/types";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { fmtDateTime } from "../../lib/format";
import { summarizeProviderMessage } from "./shared";

function formatFetchedAt(value: string): string {
    return fmtDateTime(value, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

interface DataProvenanceProps {
    title?: string;
    provenance?: DashboardProvenance | DashboardSectionProvenance;
    providerSummary?: ProviderFetchSummary[];
    compact?: boolean;
}

export function DataProvenance({
    title = "Data provenance",
    provenance,
    providerSummary = [],
    compact = false,
}: DataProvenanceProps) {
    if (!provenance) {
        return null;
    }

    const relevantProviders = providerSummary.filter((entry) => provenance.providers.includes(entry.provider));
    const providerDetails =
        provenance.providerDetails.length > 0
            ? provenance.providerDetails
            : relevantProviders.map((entry) => ({
                  provider: entry.provider,
                  sourceContract: entry.sourceContract,
                  count: entry.count,
                  fetchedAt: entry.fetchedAt,
                  status: entry.error ? "error" : entry.count === 0 ? "warning" : "ok",
                  message: entry.error
                      ? entry.error
                      : entry.count === 0
                        ? "Returned 0 rows for the current filters."
                        : undefined,
              }));

    return (
        <Card className={cn("border-white/5 bg-white/[0.02]", compact && "bg-black/20")}>
            <CardHeader className={cn("pb-3", compact && "pb-2")}>
                <CardTitle className="text-sm font-mono text-amber-300">{title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                {provenance.note ? (
                    <p className="text-xs font-mono leading-5 text-slate-400">{provenance.note}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                    {provenance.providers.map((provider) => (
                        <Badge
                            key={provider}
                            variant="outline"
                            className="border-white/10 bg-white/[0.03] font-mono text-[10px] uppercase tracking-[0.2em] text-slate-300"
                        >
                            {provider}
                        </Badge>
                    ))}
                    {provenance.count !== undefined ? (
                        <Badge
                            variant="outline"
                            className="border-cyan-500/20 bg-cyan-500/10 font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-300"
                        >
                            {provenance.count} rows
                        </Badge>
                    ) : null}
                </div>
                {"metrics" in provenance && provenance.metrics && provenance.metrics.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                        {provenance.metrics.map((metric) => (
                            <Badge
                                key={metric}
                                variant="outline"
                                className="border-amber-500/20 bg-amber-500/5 font-mono text-[10px] text-amber-200"
                            >
                                {metric}
                            </Badge>
                        ))}
                    </div>
                ) : null}
                {providerDetails.length > 0 ? (
                    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                        {providerDetails.map((detail) => (
                            <div
                                key={`${detail.provider}-${detail.sourceContract}-${detail.fetchedAt}`}
                                className="rounded-lg border border-white/5 bg-slate-950/50 px-3 py-2"
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-slate-500">
                                            {detail.provider}
                                        </div>
                                        <div className="mt-1 text-xs font-mono text-slate-300">
                                            {detail.sourceContract}
                                        </div>
                                    </div>
                                    <Badge
                                        variant="outline"
                                        className={cn(
                                            "font-mono text-[10px] uppercase tracking-[0.2em]",
                                            detail.status === "error"
                                                ? "border-red-500/20 bg-red-500/10 text-red-300"
                                                : detail.status === "warning"
                                                  ? "border-amber-500/20 bg-amber-500/10 text-amber-200"
                                                  : "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                                        )}
                                    >
                                        {detail.status}
                                    </Badge>
                                </div>
                                <div className="mt-2 text-xs font-mono text-slate-300">{detail.count} rows</div>
                                <div className="mt-1 text-[11px] font-mono text-slate-500">
                                    fetched {formatFetchedAt(detail.fetchedAt)}
                                </div>
                                {detail.message ? (
                                    <div
                                        title={detail.message}
                                        className={cn(
                                            "mt-2 break-words text-[11px] font-mono leading-5",
                                            detail.status === "error" ? "text-red-300" : "text-amber-200"
                                        )}
                                    >
                                        {summarizeProviderMessage(detail.message)}
                                    </div>
                                ) : null}
                            </div>
                        ))}
                    </div>
                ) : null}
            </CardContent>
        </Card>
    );
}
