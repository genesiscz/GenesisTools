import type { LiveEventName } from "@app/shops/types";
import type { SseStatus } from "@app/shops/ui/hooks/useSseStream";
import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { Pause, Play, Trash2 } from "lucide-react";

interface LiveFilterBarProps {
    enabledEvents: Set<LiveEventName>;
    onToggleEvent: (event: LiveEventName) => void;
    paused: boolean;
    onTogglePause: () => void;
    onClear: () => void;
    filterText: string;
    onFilterText: (text: string) => void;
    status: SseStatus;
    queueSize: number;
}

const ALL_EVENTS: Array<{ name: LiveEventName; label: string; color: string }> = [
    { name: "http-request", label: "HTTP", color: "border-cyan-400/40 text-cyan-300" },
    { name: "crawl-progress", label: "CRAWL", color: "border-emerald-400/40 text-emerald-300" },
    { name: "notification-fired", label: "ALERT", color: "border-amber-400/40 text-amber-300" },
];

function statusBadge(status: SseStatus) {
    if (status === "live") {
        return { label: "LIVE", className: "border-emerald-400/40 text-emerald-300" };
    }

    if (status === "connecting") {
        return { label: "CONNECTING", className: "border-amber-400/40 text-amber-300" };
    }

    if (status === "reconnecting") {
        return { label: "RECONNECTING", className: "border-amber-400/40 text-amber-300" };
    }

    return { label: "DOWN", className: "border-rose-400/40 text-rose-300" };
}

export function LiveFilterBar({
    enabledEvents,
    onToggleEvent,
    paused,
    onTogglePause,
    onClear,
    filterText,
    onFilterText,
    status,
    queueSize,
}: LiveFilterBarProps) {
    const sb = statusBadge(status);

    return (
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between border-b border-border pb-3">
            <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={`font-mono text-[10px] tracking-[0.2em] uppercase ${sb.className}`}>
                    {sb.label}
                </Badge>
                <span className="font-mono text-[10px] text-muted-foreground">{queueSize} events</span>
                {ALL_EVENTS.map(({ name, label, color }) => {
                    const enabled = enabledEvents.has(name);
                    return (
                        <button
                            type="button"
                            key={name}
                            onClick={() => onToggleEvent(name)}
                            className={`font-mono text-[10px] tracking-[0.15em] uppercase border rounded px-1.5 py-0.5 transition-colors ${
                                enabled ? color : "border-border text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            {label}
                        </button>
                    );
                })}
            </div>
            <div className="flex items-center gap-2">
                <Input
                    value={filterText}
                    onChange={(e) => onFilterText(e.target.value)}
                    placeholder="filter URL / shop"
                    className="w-48 font-mono text-xs"
                />
                <Button variant="outline" size="sm" onClick={onTogglePause} className="font-mono text-xs">
                    {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                </Button>
                <Button variant="outline" size="sm" onClick={onClear} className="font-mono text-xs">
                    <Trash2 className="w-3.5 h-3.5" />
                </Button>
            </div>
        </div>
    );
}
