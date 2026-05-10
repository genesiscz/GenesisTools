import type { LiveEvent, LiveEventName } from "@app/shops/types";
import { useMemo, useRef, useState } from "react";
import type { SseStatus } from "@app/shops/ui/hooks/useSseStream";
import { useSseStream } from "@app/shops/ui/hooks/useSseStream";
import { LiveEventRow } from "@app/shops/ui/components/LiveEventRow";
import { LiveFilterBar } from "@app/shops/ui/components/LiveFilterBar";

const MAX_FRAMES = 1000;
const ALL_EVENTS = ["http-request", "crawl-progress", "notification-fired"] as const;

interface BatchFrame {
    type: LiveEventName;
    data: unknown;
}

export function LiveFeed() {
    const [enabledEvents, setEnabledEvents] = useState<Set<LiveEventName>>(new Set(ALL_EVENTS));
    const [paused, setPaused] = useState(false);
    const [filterText, setFilterText] = useState("");
    const [status, setStatus] = useState<SseStatus>("connecting");
    const [frames, setFrames] = useState<LiveEvent[]>([]);
    const pausedRef = useRef(paused);
    pausedRef.current = paused;

    const onBatch = useMemo(
        () => (batch: BatchFrame[]) => {
            if (pausedRef.current) {
                return;
            }

            const mapped: LiveEvent[] = batch
                .map((b) => {
                    const data = b.data as Record<string, unknown>;
                    return { event: b.type, ...data } as unknown as LiveEvent;
                })
                .reverse();
            setFrames((prev) => [...mapped, ...prev].slice(0, MAX_FRAMES));
        },
        []
    );

    useSseStream({
        url: "/api/live/events",
        events: ALL_EVENTS,
        onBatch,
        onStatusChange: setStatus,
    });

    const toggleEvent = (event: LiveEventName) => {
        setEnabledEvents((prev) => {
            const next = new Set(prev);
            if (next.has(event)) {
                next.delete(event);
            } else {
                next.add(event);
            }

            return next;
        });
    };

    const filtered = useMemo(() => {
        const lower = filterText.toLowerCase();
        return frames.filter((f) => {
            if (!enabledEvents.has(f.event)) {
                return false;
            }

            if (lower.length === 0) {
                return true;
            }

            if (f.event === "http-request") {
                return f.url.toLowerCase().includes(lower) || (f.shop_origin?.toLowerCase().includes(lower) ?? false);
            }

            if (f.event === "crawl-progress") {
                return f.shop_origin.toLowerCase().includes(lower) || f.strategy.toLowerCase().includes(lower);
            }

            if (f.event === "notification-fired") {
                return f.title.toLowerCase().includes(lower) || f.body.toLowerCase().includes(lower);
            }

            return false;
        });
    }, [frames, enabledEvents, filterText]);

    return (
        <div className="space-y-3">
            <LiveFilterBar
                enabledEvents={enabledEvents}
                onToggleEvent={toggleEvent}
                paused={paused}
                onTogglePause={() => setPaused((p) => !p)}
                onClear={() => setFrames([])}
                filterText={filterText}
                onFilterText={setFilterText}
                status={status}
                queueSize={filtered.length}
            />
            <div className="border border-zinc-800 rounded-md overflow-hidden">
                <div className="max-h-[70vh] overflow-y-auto">
                    {filtered.length === 0 ? (
                        <div className="p-12 text-center font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
                            no events yet — fire up a crawl: tools shops crawl --shop rohlik
                        </div>
                    ) : (
                        filtered.map((f, i) => (
                            <LiveEventRow
                                key={`${f.event}-${"id" in f ? f.id : "ts" in f ? f.ts : i}-${i}`}
                                frame={f}
                            />
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
