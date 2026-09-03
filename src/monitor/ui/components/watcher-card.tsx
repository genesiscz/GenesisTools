import { isMuted, type WatcherSummary } from "@app/monitor/lib/types";
import { useDeleteWatcher, useRunWatcher, useUpdateWatcher } from "@app/monitor/ui/api.hooks";
import { LatencySparkline } from "@app/monitor/ui/components/latency-sparkline";
import { StatusBadge, StatusDot, statusKey } from "@app/monitor/ui/components/status-badge";
import {
    displayTarget,
    formatAgo,
    formatDateTime,
    formatInterval,
    formatLatency,
    formatUptime,
    KIND_LABEL,
} from "@app/monitor/ui/lib/format";
import { Button } from "@genesiscz/utils/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@genesiscz/utils/ui/components/dropdown-menu";
import { cn } from "@genesiscz/utils/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import {
    Bell,
    BellOff,
    Bot,
    Braces,
    Globe,
    Loader2,
    MoreHorizontal,
    Network,
    Pause,
    Pencil,
    Play,
    Plug,
    RefreshCw,
    Rss,
    ShieldCheck,
    Terminal,
    Trash2,
    Waves,
} from "lucide-react";
import type { MouseEvent } from "react";

/** ISO time `minutes` from now, for a maintenance mute. */
export function muteUntil(minutes: number): string {
    return new Date(Date.now() + minutes * 60_000).toISOString();
}

const KIND_ICON = {
    website: Globe,
    statuspage: Waves,
    "ai-provider": Bot,
    rss: Rss,
    tcp: Plug,
    dns: Network,
    tls: ShieldCheck,
    json: Braces,
    command: Terminal,
} as const;

export function WatcherCard({
    watcher,
    onEdit,
}: {
    watcher: WatcherSummary;
    onEdit: (watcher: WatcherSummary) => void;
}) {
    const run = useRunWatcher();
    const update = useUpdateWatcher();
    const remove = useDeleteWatcher();
    const KindIcon = KIND_ICON[watcher.kind];
    const key = statusKey(watcher.lastStatus, watcher.enabled);
    const running = run.isPending && run.variables === watcher.id;

    function stop(event: MouseEvent) {
        event.preventDefault();
        event.stopPropagation();
    }

    return (
        <Link
            to="/watchers/$id"
            params={{ id: String(watcher.id) }}
            className={cn(
                "group mon-panel mon-card-hover relative flex flex-col gap-4 rounded-3xl p-5 outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                `mon-status-${key}`,
                !watcher.enabled && "opacity-70"
            )}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                    <StatusDot status={watcher.lastStatus} enabled={watcher.enabled} />
                    <div className="min-w-0">
                        <h3 className="truncate text-base font-semibold text-foreground">{watcher.name}</h3>
                        <p className="flex items-center gap-1.5 truncate font-mono text-[0.7rem] text-muted-foreground">
                            <KindIcon className="size-3 shrink-0" />
                            <span className="truncate">{displayTarget(watcher.kind, watcher.target)}</span>
                        </p>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1" onClick={stop}>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Check now"
                        disabled={running}
                        onClick={(event) => {
                            stop(event);
                            run.mutate(watcher.id);
                        }}
                    >
                        {running ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                    </Button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" title="More" onClick={stop}>
                                <MoreHorizontal className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="mon-panel border-primary/25">
                            <DropdownMenuItem onClick={() => onEdit(watcher)}>
                                <Pencil className="size-4" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => update.mutate({ id: watcher.id, patch: { enabled: !watcher.enabled } })}
                            >
                                {watcher.enabled ? (
                                    <>
                                        <Pause className="size-4" /> Pause
                                    </>
                                ) : (
                                    <>
                                        <Play className="size-4" /> Resume
                                    </>
                                )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {isMuted(watcher) ? (
                                <DropdownMenuItem
                                    onClick={() => update.mutate({ id: watcher.id, patch: { mutedUntil: null } })}
                                >
                                    <Bell className="size-4" /> Unmute
                                </DropdownMenuItem>
                            ) : (
                                <>
                                    <DropdownMenuItem
                                        onClick={() =>
                                            update.mutate({ id: watcher.id, patch: { mutedUntil: muteUntil(60) } })
                                        }
                                    >
                                        <BellOff className="size-4" /> Silence 1 hour
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() =>
                                            update.mutate({ id: watcher.id, patch: { mutedUntil: muteUntil(24 * 60) } })
                                        }
                                    >
                                        <BellOff className="size-4" /> Silence 24 hours
                                    </DropdownMenuItem>
                                </>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => {
                                    if (window.confirm(`Delete "${watcher.name}" and its history?`)) {
                                        remove.mutate(watcher.id);
                                    }
                                }}
                            >
                                <Trash2 className="size-4" /> Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            <div className="flex items-end justify-between gap-4">
                <div>
                    <p className="text-3xl font-bold tracking-tight text-foreground">
                        {formatLatency(watcher.lastLatencyMs)}
                    </p>
                    <p className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">latency</p>
                </div>
                <div className="text-right">
                    <p className="text-xl font-semibold text-foreground">{formatUptime(watcher.uptime24h)}</p>
                    <p className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground">
                        uptime 24h
                    </p>
                </div>
            </div>

            <LatencySparkline points={watcher.recent} />

            <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                    <StatusBadge status={watcher.lastStatus} enabled={watcher.enabled} />
                    {isMuted(watcher) && (
                        <span
                            title={`Muted until ${formatDateTime(watcher.mutedUntil)}`}
                            className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-[0.18em] text-muted-foreground"
                        >
                            <BellOff className="size-3" /> muted
                        </span>
                    )}
                </span>
                <p className="truncate font-mono text-[0.65rem] text-muted-foreground">
                    {KIND_LABEL[watcher.kind]} · every {formatInterval(watcher.intervalSec)} ·{" "}
                    {formatAgo(watcher.lastCheckedAt)}
                </p>
            </div>

            {watcher.lastDetail && (
                <p className="line-clamp-2 text-xs leading-5 text-muted-foreground" title={watcher.lastDetail}>
                    {watcher.lastDetail}
                </p>
            )}
        </Link>
    );
}
