import type { PropertyAnalysisHistoryRow, SavedPropertyRow } from "@app/Internal/commands/reas/lib/store";
import { Link } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Checkbox } from "@ui/components/checkbox";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib/utils";
import { CheckSquare, ChevronDown, ChevronUp, ExternalLink, Loader2, RefreshCw, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { buildCompareSearchParams } from "../compare/compare-query";
import { PropertyMortgageCard } from "./PropertyMortgageCard";
import { PropertyVerdictMini } from "./PropertyVerdictMini";
import { PropertyYieldBreakdown } from "./PropertyYieldBreakdown";
import { buildPropertyCardModel } from "./property-card-model";
import { PropertySparkline } from "./property-sparkline";
import {
    formatConstructionType,
    formatCurrencyCompact,
    formatDisposition,
    formatNumber,
    formatPercent,
    formatYield,
    GRADE_COLORS,
    getStalenessInfo,
    PROVIDER_BADGE_STYLES,
    PROVIDER_LABELS,
    parseSavedProviders,
} from "./watchlist-utils";

interface PropertyCardProps {
    property: SavedPropertyRow;
    history: PropertyAnalysisHistoryRow[];
    onRefresh: (id: number) => Promise<void>;
    onDelete: (id: number) => void;
    onUpdateAlerts?: (options: { id: number; alertYieldFloor?: number; alertGradeChange: boolean }) => Promise<void>;
    selectedForCompare?: boolean;
    onToggleCompare?: (id: number) => void;
}

interface MetricItemProps {
    label: string;
    value: string;
    tone?: "default" | "accent" | "success" | "warning" | "danger";
}

function MetricItem({ label, value, tone = "default" }: MetricItemProps) {
    return (
        <div className="rounded-md border border-white/5 bg-white/[0.02] px-3 py-2">
            <div className="text-[10px] font-mono uppercase tracking-wider text-gray-600 truncate">{label}</div>
            <div
                className={cn(
                    "mt-1 text-sm font-mono font-semibold",
                    tone === "accent" && "text-cyan-400",
                    tone === "success" && "text-emerald-400",
                    tone === "warning" && "text-amber-400",
                    tone === "danger" && "text-rose-400",
                    tone === "default" && "text-gray-200"
                )}
            >
                {value}
            </div>
        </div>
    );
}

export function PropertyCard({
    property,
    history,
    onRefresh,
    onDelete,
    onUpdateAlerts,
    selectedForCompare = false,
    onToggleCompare,
}: PropertyCardProps) {
    const [refreshing, setRefreshing] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [alertYieldFloor, setAlertYieldFloor] = useState("");
    const [alertGradeChange, setAlertGradeChange] = useState(false);
    const [savingAlerts, setSavingAlerts] = useState(false);
    const [alertValidationMessage, setAlertValidationMessage] = useState<string | null>(null);

    const staleness = getStalenessInfo(property.last_analyzed_at);
    const gradeStyle = property.last_grade ? (GRADE_COLORS[property.last_grade] ?? "") : "";
    const providers = parseSavedProviders(property.providers);
    const cardModel = buildPropertyCardModel(property);
    const canExpand = Boolean(cardModel || onUpdateAlerts);
    const compareHref = `/compare?${buildCompareSearchParams({
        districts: [property.district],
        propertyType: property.construction_type,
        disposition: property.disposition,
        price: property.target_price,
        area: property.target_area,
    }).toString()}`;
    const alertYieldTriggered =
        property.alert_yield_floor != null &&
        property.last_net_yield != null &&
        property.last_net_yield < property.alert_yield_floor;

    useEffect(() => {
        setAlertYieldFloor(property.alert_yield_floor != null ? String(property.alert_yield_floor) : "");
        setAlertGradeChange(Boolean(property.alert_grade_change));
        setAlertValidationMessage(null);
    }, [property.alert_grade_change, property.alert_yield_floor]);

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);

        try {
            await onRefresh(property.id);
        } finally {
            setRefreshing(false);
        }
    }, [property.id, onRefresh]);

    const handleDelete = useCallback(() => {
        if (confirmDelete) {
            onDelete(property.id);
            setConfirmDelete(false);
            return;
        }

        setConfirmDelete(true);
        setTimeout(() => setConfirmDelete(false), 3000);
    }, [property.id, onDelete, confirmDelete]);

    const handleSaveAlerts = useCallback(async () => {
        if (!onUpdateAlerts) {
            return;
        }

        const trimmedYieldFloor = alertYieldFloor.trim();
        const parsedYieldFloor = trimmedYieldFloor ? Number(trimmedYieldFloor) : undefined;

        if (trimmedYieldFloor && !Number.isFinite(parsedYieldFloor)) {
            setAlertValidationMessage("Yield floor must be a valid number.");
            return;
        }

        setAlertValidationMessage(null);

        setSavingAlerts(true);

        try {
            await onUpdateAlerts({
                id: property.id,
                alertYieldFloor: parsedYieldFloor,
                alertGradeChange,
            });
        } finally {
            setSavingAlerts(false);
        }
    }, [alertGradeChange, alertYieldFloor, onUpdateAlerts, property.id]);

    return (
        <Card className="border-white/10 bg-white/[0.02] hover:border-amber-500/30 hover:shadow-[0_0_20px_rgba(245,158,11,0.07)] transition-all duration-200">
            <CardHeader className="space-y-3 pb-3">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                        <CardTitle className="text-sm font-mono text-gray-200 truncate">{property.name}</CardTitle>
                        <p className="text-[11px] font-mono text-gray-500">
                            {property.district} · {formatConstructionType(property.construction_type)} ·{" "}
                            {formatDisposition(property.disposition)}
                        </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        {property.last_grade && (
                            <Badge variant="outline" className={cn("text-xs font-mono font-bold", gradeStyle)}>
                                {property.last_grade}
                            </Badge>
                        )}

                        <Badge variant="outline" className={cn("text-[10px] font-mono", staleness.color)}>
                            {staleness.label}
                        </Badge>
                    </div>
                </div>

                {property.listing_url && (
                    <a
                        href={property.listing_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-w-0 items-center gap-1.5 text-[10px] font-mono text-cyan-400 hover:text-cyan-300"
                    >
                        <ExternalLink className="h-3 w-3 shrink-0" />
                        <span className="truncate">{property.listing_url}</span>
                    </a>
                )}

                {providers.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {providers.map((provider) => (
                            <Badge
                                key={provider}
                                variant="outline"
                                className={cn(
                                    "border-white/10 bg-white/[0.02] text-[10px] font-mono",
                                    PROVIDER_BADGE_STYLES[provider] ?? "text-gray-400"
                                )}
                            >
                                {PROVIDER_LABELS[provider] ?? provider}
                            </Badge>
                        ))}
                    </div>
                )}
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                        <MetricItem label="Net Yield" value={formatYield(property.last_net_yield)} tone="accent" />
                        <PropertySparkline
                            history={history}
                            getValue={(row) => row.net_yield}
                            stroke="rgb(6 182 212)"
                        />
                    </div>
                    <div className="space-y-1">
                        <MetricItem label="Score" value={formatNumber(property.last_score)} tone="warning" />
                        <PropertySparkline history={history} getValue={(row) => row.score} stroke="rgb(245 158 11)" />
                    </div>
                    <div className="space-y-1">
                        <MetricItem
                            label="Median CZK/m2"
                            value={formatCurrencyCompact(property.last_median_price_per_m2)}
                            tone="default"
                        />
                        <PropertySparkline
                            history={history}
                            getValue={(row) => row.median_price_per_m2}
                            stroke="rgb(148 163 184)"
                        />
                    </div>
                    <MetricItem
                        label="Target Price"
                        value={formatCurrencyCompact(property.target_price)}
                        tone="default"
                    />
                </div>

                {cardModel && (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {cardModel.metrics.map((metric) => (
                            <div key={metric.label} className="space-y-1">
                                <MetricItem label={metric.label} value={metric.value} tone={metric.tone} />
                                {metric.label === "Net Yield" && (
                                    <PropertySparkline
                                        history={history}
                                        getValue={(row) => row.net_yield}
                                        stroke="rgb(6 182 212)"
                                    />
                                )}
                                {metric.label === "CZK/m2" && (
                                    <PropertySparkline
                                        history={history}
                                        getValue={(row) => row.median_price_per_m2}
                                        stroke="rgb(148 163 184)"
                                    />
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {canExpand && (
                    <>
                        {expanded && (
                            <>
                                {cardModel ? (
                                    <div className="grid gap-3 xl:grid-cols-3">
                                        <PropertyVerdictMini grade={property.last_grade} model={cardModel} />
                                        <PropertyYieldBreakdown model={cardModel} />
                                        <PropertyMortgageCard mortgage={cardModel.mortgage} />
                                    </div>
                                ) : (
                                    <div className="rounded-lg border border-dashed border-white/10 bg-black/20 px-3 py-4 text-[11px] font-mono text-gray-400">
                                        This card has no stored analysis yet. You can still manage alerts now and
                                        refresh later to unlock the full dossier.
                                    </div>
                                )}

                                {onUpdateAlerts && (
                                    <div className="rounded-lg border border-white/5 bg-black/20 p-3">
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div>
                                                <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-gray-500">
                                                    Alerts
                                                </div>
                                                <div className="mt-1 text-[11px] font-mono text-gray-400">
                                                    Keep thresholds attached to the watchlist card while you screen.
                                                </div>
                                            </div>

                                            <div className="flex flex-wrap gap-2 text-[10px] font-mono">
                                                <Badge
                                                    variant="outline"
                                                    className={cn(
                                                        "bg-white/[0.02]",
                                                        alertYieldTriggered
                                                            ? "border-rose-500/30 text-rose-300"
                                                            : "border-white/10 text-gray-400"
                                                    )}
                                                >
                                                    Current {formatYield(property.last_net_yield)}
                                                </Badge>
                                                <Badge
                                                    variant="outline"
                                                    className={cn(
                                                        "bg-white/[0.02]",
                                                        property.alert_grade_change
                                                            ? "border-amber-500/20 text-amber-300"
                                                            : "border-white/10 text-gray-500"
                                                    )}
                                                >
                                                    Grade change {property.alert_grade_change ? "on" : "off"}
                                                </Badge>
                                            </div>
                                        </div>

                                        <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,160px)_1fr_auto] md:items-end">
                                            <div>
                                                <label
                                                    htmlFor={`property-alert-yield-${property.id}`}
                                                    className="mb-1 block text-[10px] font-mono text-gray-500"
                                                >
                                                    Yield floor (%)
                                                </label>
                                                <Input
                                                    id={`property-alert-yield-${property.id}`}
                                                    type="number"
                                                    value={alertYieldFloor}
                                                    onChange={(event) => {
                                                        setAlertYieldFloor(event.target.value);
                                                        setAlertValidationMessage(null);
                                                    }}
                                                    placeholder="4.5"
                                                    className="h-8 border-white/10 bg-black/20 text-xs font-mono"
                                                />
                                            </div>

                                            <label className="flex h-8 items-center gap-2 rounded border border-white/10 bg-black/20 px-3 text-[11px] font-mono text-gray-300">
                                                <Checkbox
                                                    id={`property-alert-grade-${property.id}`}
                                                    checked={alertGradeChange}
                                                    onCheckedChange={(checked) => {
                                                        setAlertGradeChange(checked === true);
                                                        setAlertValidationMessage(null);
                                                    }}
                                                />
                                                <span>Alert on grade change</span>
                                            </label>

                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                onClick={handleSaveAlerts}
                                                disabled={savingAlerts}
                                                className="h-8 border-amber-500/30 text-xs font-mono text-amber-300 hover:bg-amber-500/10"
                                            >
                                                {savingAlerts ? "Saving..." : "Save Alerts"}
                                            </Button>
                                        </div>

                                        {alertValidationMessage && (
                                            <p className="mt-2 text-[10px] font-mono text-rose-300">
                                                {alertValidationMessage}
                                            </p>
                                        )}
                                    </div>
                                )}
                            </>
                        )}

                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setExpanded((current) => !current)}
                            className="h-8 border-white/10 text-xs font-mono text-gray-300 hover:bg-white/[0.04]"
                        >
                            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            {expanded ? "Collapse Card" : cardModel ? "Expand Analysis" : "Expand Alerts"}
                        </Button>
                    </>
                )}

                <div className="flex flex-wrap gap-2 text-[10px] font-mono">
                    <Badge variant="outline" className="border-white/10 text-gray-400 bg-white/[0.02]">
                        Area {formatNumber(property.target_area, 0)} m2
                    </Badge>
                    <Badge variant="outline" className="border-white/10 text-gray-400 bg-white/[0.02]">
                        Rent {formatCurrencyCompact(property.monthly_rent)}
                    </Badge>
                    <Badge variant="outline" className="border-white/10 text-gray-400 bg-white/[0.02]">
                        DOM {formatNumber(property.time_on_market)}
                    </Badge>
                    <Badge variant="outline" className="border-white/10 text-gray-400 bg-white/[0.02]">
                        Comps {formatNumber(property.comparable_count)}
                    </Badge>
                    <Badge variant="outline" className="border-white/10 text-gray-400 bg-white/[0.02]">
                        Rentals {formatNumber(property.rental_count)}
                    </Badge>
                    <Badge variant="outline" className="border-white/10 text-gray-400 bg-white/[0.02]">
                        Discount {formatPercent(property.discount_vs_market)}
                    </Badge>
                    <Badge variant="outline" className="border-white/10 text-gray-400 bg-white/[0.02]">
                        Momentum {property.momentum ?? "-"}
                    </Badge>
                    <Badge variant="outline" className="border-white/10 text-gray-400 bg-white/[0.02]">
                        Percentile {property.percentile != null ? `${property.percentile.toFixed(0)}th` : "-"}
                    </Badge>
                    {property.alert_yield_floor != null && (
                        <Badge variant="outline" className="border-amber-500/20 text-amber-300 bg-amber-500/5">
                            Alert yield &lt; {property.alert_yield_floor.toFixed(1)}%
                        </Badge>
                    )}
                    {property.alert_grade_change ? (
                        <Badge variant="outline" className="border-rose-500/20 text-rose-300 bg-rose-500/5">
                            Alert on grade change
                        </Badge>
                    ) : null}
                </div>

                {property.notes && (
                    <p className="rounded-md border border-white/5 bg-black/20 px-3 py-2 text-[10px] font-mono text-gray-500 italic">
                        {property.notes}
                    </p>
                )}

                <div className="grid grid-cols-2 gap-2 pt-1">
                    {onToggleCompare && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onToggleCompare(property.id)}
                            className={cn(
                                "col-span-2 h-8 text-xs font-mono",
                                selectedForCompare
                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                    : "border-white/10 text-gray-300 hover:bg-white/[0.04]"
                            )}
                        >
                            {selectedForCompare ? <CheckSquare className="w-3 h-3" /> : <Square className="w-3 h-3" />}
                            {selectedForCompare ? "Selected for Compare" : "Select for Compare"}
                        </Button>
                    )}

                    <Button
                        size="sm"
                        variant="outline"
                        onClick={handleRefresh}
                        disabled={refreshing}
                        className="h-8 text-xs font-mono border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/10"
                    >
                        {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                        Refresh
                    </Button>

                    <Button
                        size="sm"
                        variant="outline"
                        asChild
                        className="h-8 text-xs font-mono border-amber-500/20 text-amber-400 hover:bg-amber-500/10"
                    >
                        <Link to="/watchlist/$propertyId" params={{ propertyId: String(property.id) }}>
                            Details
                        </Link>
                    </Button>

                    <Button
                        size="sm"
                        variant="outline"
                        asChild
                        className="h-8 text-xs font-mono border-white/10 text-gray-300 hover:bg-white/[0.04]"
                    >
                        <Link to={compareHref}>Compare District</Link>
                    </Button>

                    <Button
                        size="sm"
                        variant="outline"
                        onClick={handleDelete}
                        className={cn(
                            "col-span-2 h-8 text-xs font-mono",
                            confirmDelete
                                ? "border-red-500/40 text-red-400 bg-red-500/10"
                                : "border-red-500/20 text-red-400 hover:bg-red-500/10"
                        )}
                    >
                        <Trash2 className="w-3 h-3" />
                        {confirmDelete ? "Confirm Delete" : "Delete from Watchlist"}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
