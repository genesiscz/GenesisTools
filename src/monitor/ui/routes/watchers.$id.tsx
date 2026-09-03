import type { CheckRecord, WatcherSummary } from "@app/monitor/lib/types";
import {
    useChecks,
    useDeleteWatcher,
    useFeedItems,
    useLiveStatus,
    useRunWatcher,
    useTargets,
    useUpdateWatcher,
    useWatcher,
    useWatcherIncidents,
} from "@app/monitor/ui/api.hooks";
import { ChecksTable } from "@app/monitor/ui/components/checks-table";
import { IncidentsTable } from "@app/monitor/ui/components/incidents-table";
import { ErrorPanel, Loading } from "@app/monitor/ui/components/loading";
import { PageHeader } from "@app/monitor/ui/components/page-header";
import { StatusBadge } from "@app/monitor/ui/components/status-badge";
import { WatcherDialog } from "@app/monitor/ui/components/watcher-dialog";
import {
    displayTarget,
    formatAgo,
    formatInterval,
    formatLatency,
    formatTime,
    formatUptime,
    KIND_LABEL,
} from "@app/monitor/ui/lib/format";
import { Button } from "@genesiscz/utils/ui/components/button";
import {
    Area,
    AreaChart,
    CartesianGrid,
    ChartContainer,
    chartAxisProps,
    chartGridProps,
    chartTooltipStyle,
    ReferenceLine,
    Tooltip,
    XAxis,
    YAxis,
} from "@genesiscz/utils/ui/graphs";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Loader2, Pause, Pencil, Play, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

export const Route = createFileRoute("/watchers/$id")({
    component: WatcherPage,
});

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="mon-panel rounded-2xl p-4">
            <p className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-bold text-foreground">{value}</p>
            {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        </div>
    );
}

interface ChartPoint {
    t: string;
    label: string;
    latency: number | null;
    status: CheckRecord["status"];
}

function toChartPoints(checks: CheckRecord[]): ChartPoint[] {
    return checks
        .slice()
        .reverse()
        .map((check) => ({
            t: check.checkedAt,
            label: formatTime(check.checkedAt),
            latency: check.latencyMs,
            status: check.status,
        }));
}

function LatencyChart({ checks, threshold }: { checks: CheckRecord[]; threshold?: number }) {
    const points = useMemo(() => toChartPoints(checks), [checks]);

    if (points.length < 2) {
        return (
            <div className="mon-panel grid h-64 place-items-center rounded-3xl text-sm text-muted-foreground">
                Latency history appears after a couple of checks.
            </div>
        );
    }

    return (
        <ChartContainer
            className="mon-panel rounded-3xl"
            title="Latency"
            description={`Last ${points.length} checks, oldest on the left`}
            height={260}
        >
            <AreaChart data={points} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <defs>
                    <linearGradient id="mon-latency" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity={0.5} />
                        <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity={0} />
                    </linearGradient>
                </defs>
                <CartesianGrid {...chartGridProps} />
                <XAxis dataKey="label" {...chartAxisProps} minTickGap={32} />
                <YAxis {...chartAxisProps} tickFormatter={(value: number) => `${value}`} unit=" ms" width={70} />
                <Tooltip
                    contentStyle={chartTooltipStyle}
                    formatter={(value) => [formatLatency(typeof value === "number" ? value : null), "latency"]}
                    labelFormatter={(label, payload) => {
                        const point = payload?.[0]?.payload as ChartPoint | undefined;

                        return point ? `${label} · ${point.status}` : String(label);
                    }}
                />
                {threshold !== undefined && (
                    <ReferenceLine
                        y={threshold}
                        stroke="rgb(245 158 11)"
                        strokeDasharray="4 4"
                        label={{ value: "degraded", fill: "rgb(245 158 11)", fontSize: 10, position: "insideTopRight" }}
                    />
                )}
                <Area
                    type="monotone"
                    dataKey="latency"
                    stroke="rgb(16 185 129)"
                    strokeWidth={2}
                    fill="url(#mon-latency)"
                    connectNulls={false}
                    dot={false}
                    isAnimationActive={false}
                />
            </AreaChart>
        </ChartContainer>
    );
}

function Header({ watcher }: { watcher: WatcherSummary }) {
    const live = useLiveStatus();
    const run = useRunWatcher();
    const update = useUpdateWatcher();
    const remove = useDeleteWatcher();
    const navigate = useNavigate();
    const [editing, setEditing] = useState(false);
    const isUrl = watcher.kind !== "ai-provider";

    async function onDelete() {
        if (!window.confirm(`Delete "${watcher.name}" and its history?`)) {
            return;
        }

        await remove.mutateAsync(watcher.id);
        void navigate({ to: "/" });
    }

    return (
        <>
            <PageHeader
                eyebrow={`${KIND_LABEL[watcher.kind]} · every ${formatInterval(watcher.intervalSec)}`}
                live={live}
                title={
                    <span className="flex flex-wrap items-center gap-3">
                        {watcher.name}
                        <StatusBadge status={watcher.lastStatus} enabled={watcher.enabled} className="text-xs" />
                    </span>
                }
                description={
                    <span className="flex flex-col gap-1">
                        {isUrl ? (
                            <a
                                href={watcher.target}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 font-mono text-xs text-secondary hover:underline"
                            >
                                {displayTarget(watcher.kind, watcher.target)} <ExternalLink className="size-3" />
                            </a>
                        ) : (
                            <span className="font-mono text-xs text-secondary">{watcher.target}</span>
                        )}
                        {watcher.lastDetail && <span>{watcher.lastDetail}</span>}
                        <span className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
                            {watcher.notify ? <TargetNames ids={watcher.targetIds} /> : "notifications muted"}
                        </span>
                    </span>
                }
                actions={
                    <>
                        <Button variant="outline" size="sm" asChild>
                            <Link to="/">
                                <ArrowLeft className="size-4" /> Overview
                            </Link>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={run.isPending}
                            onClick={() => run.mutate(watcher.id)}
                        >
                            {run.isPending ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <RefreshCw className="size-4" />
                            )}
                            Check now
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => update.mutate({ id: watcher.id, patch: { enabled: !watcher.enabled } })}
                        >
                            {watcher.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
                            {watcher.enabled ? "Pause" : "Resume"}
                        </Button>
                        <Button size="sm" className="btn-glow" onClick={() => setEditing(true)}>
                            <Pencil className="size-4" /> Edit
                        </Button>
                        <Button variant="destructive" size="sm" onClick={onDelete}>
                            <Trash2 className="size-4" /> Delete
                        </Button>
                    </>
                }
            />
            <WatcherDialog open={editing} onOpenChange={setEditing} watcher={watcher} />
        </>
    );
}

function WatcherPage() {
    const { id: rawId } = Route.useParams();

    if (!/^\d+$/.test(rawId)) {
        return <ErrorPanel title="Not a watcher id." detail={`"${rawId}" is not a number.`} />;
    }

    return <WatcherPageBody id={Number.parseInt(rawId, 10)} />;
}

function WatcherPageBody({ id }: { id: number }) {
    const watcher = useWatcher(id);
    const checks = useChecks(id, 200);
    const incidents = useWatcherIncidents(id);

    if (watcher.isPending) {
        return <Loading label="Loading watcher" cards={3} />;
    }

    if (watcher.isError || !watcher.data) {
        return <ErrorPanel title="Couldn't load this watcher." detail="It may have been deleted." />;
    }

    const data = watcher.data;

    return (
        <div className="space-y-6">
            <Header watcher={data} />

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Stat label="Latency" value={formatLatency(data.lastLatencyMs)} sub={formatAgo(data.lastCheckedAt)} />
                <Stat label="Uptime 24h" value={formatUptime(data.uptime24h)} sub={`${data.checks24h} checks`} />
                <Stat label="Avg latency 24h" value={formatLatency(data.avgLatency24h)} />
                <Stat
                    label="Open incident"
                    value={data.openIncident ? data.openIncident.status : "none"}
                    sub={data.openIncident ? `since ${formatAgo(data.openIncident.startedAt)}` : "all clear"}
                />
            </div>

            <LatencyChart checks={checks.data ?? []} threshold={data.config.degradedAboveMs} />

            <section className="space-y-3">
                <h2 className="font-mono text-[0.7rem] uppercase tracking-[0.32em] text-secondary">Incidents</h2>
                <IncidentsTable incidents={incidents.data ?? []} showWatcher={false} />
            </section>

            {data.kind === "rss" && <FeedItemsSection watcherId={data.id} />}

            <section className="space-y-3">
                <h2 className="font-mono text-[0.7rem] uppercase tracking-[0.32em] text-secondary">Recent checks</h2>
                <ChecksTable checks={checks.data ?? []} />
            </section>
        </div>
    );
}

function FeedItemsSection({ watcherId }: { watcherId: number }) {
    const items = useFeedItems(watcherId, true);
    const list = items.data ?? [];

    return (
        <section className="space-y-3">
            <h2 className="font-mono text-[0.7rem] uppercase tracking-[0.32em] text-secondary">Feed items</h2>
            {list.length === 0 ? (
                <p className="mon-panel rounded-3xl p-6 text-sm text-muted-foreground">
                    No items seen yet. The first check primes the history without delivering it; new items after that go
                    out through the watcher's targets.
                </p>
            ) : (
                <div className="mon-panel divide-y divide-primary/10 rounded-3xl">
                    {list.map((item) => (
                        <article key={item.id} className="flex flex-col gap-1 px-5 py-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                {item.link ? (
                                    <a
                                        href={item.link}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="font-medium text-foreground hover:text-primary"
                                    >
                                        {item.title}
                                    </a>
                                ) : (
                                    <span className="font-medium text-foreground">{item.title}</span>
                                )}
                                <span className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-muted-foreground">
                                    {formatAgo(item.publishedAt ?? item.seenAt)} ·{" "}
                                    {item.delivered ? "delivered" : "not delivered"}
                                </span>
                            </div>
                            {item.summary && (
                                <p className="line-clamp-2 text-xs text-muted-foreground">{item.summary}</p>
                            )}
                        </article>
                    ))}
                </div>
            )}
        </section>
    );
}

function TargetNames({ ids }: { ids: number[] }) {
    const targets = useTargets();
    const names = (targets.data ?? []).filter((target) => ids.includes(target.id)).map((target) => target.name);

    if (ids.length === 0) {
        return <span>notifies via defaults</span>;
    }

    return <span>notifies via {names.length > 0 ? names.join(", ") : `${ids.length} target(s)`}</span>;
}
