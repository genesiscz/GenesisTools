import type { ClassifiedLogEntry, LogEntry, LogLineClass } from "@app/dev-dashboard/contract/dto";
import { paths } from "@app/dev-dashboard/contract/endpoints";
import { classifyLogLine } from "@app/dev-dashboard/lib/daemon-view/classify";
import { SafeJSON } from "@app/utils/json";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { LiveSseIndicator } from "@/components/LiveSseIndicator";
import { fetchJson } from "@/lib/api";

interface Props {
    /** The selected run's log file, or null when no run is picked yet. */
    logFile: string | null;
}

interface RenderLine {
    index: number;
    cls: LogLineClass;
    text: string;
}

const BACKLOG_LIMIT = 500;

function effClass(entry: ClassifiedLogEntry | LogEntry): LogLineClass {
    const cls = (entry as ClassifiedLogEntry).cls;
    return cls ?? classifyLogLine(entry as LogEntry);
}

function lineText(entry: LogEntry): string {
    if (entry.type === "meta") {
        return `▶ ${entry.taskName} (attempt ${entry.attempt}) — ${entry.command}`;
    }

    if (entry.type === "exit") {
        const code = entry.code == null ? "?" : entry.code;
        const timedOut = entry.timedOut ? " (timed out)" : "";
        return `■ exit ${code} in ${entry.duration_ms}ms${timedOut}`;
    }

    return entry.data.replace(/\n+$/, "");
}

function colorFor(cls: LogLineClass): string {
    if (cls === "error") {
        return "#f87171";
    }

    if (cls === "warn") {
        return "var(--dd-accent-from)";
    }

    return "var(--dd-text-secondary)";
}

/**
 * Live build-log tail (web parity with the mobile feature). Seeds the list with the static backlog
 * (`GET /api/daemon/runs/log`) — FileTailer is "from now on", so the backlog fills the history — then
 * opens the SSE tail (`GET /api/daemon/runs/tail`) and appends each classified frame. Error rows are
 * tinted `#f87171`; a jump-to-error button scrolls the first error row into view. Mirrors the daemon
 * `LogModal` styling (dd-panel + var(--dd-*) tokens); reuses `LiveSseIndicator` for the live pill.
 */
export function LogStream({ logFile }: Props) {
    const [live, setLive] = useState<ClassifiedLogEntry[]>([]);
    const [sseLive, setSseLive] = useState(false);
    const [autoScroll, setAutoScroll] = useState(true);
    const listRef = useRef<HTMLDivElement>(null);
    const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

    const backlogQuery = useQuery({
        queryKey: ["build-log-tail", "backlog", logFile],
        queryFn: async (): Promise<LogEntry[]> => {
            if (!logFile) {
                return [];
            }

            const all = await fetchJson<LogEntry[]>(paths.daemonRunLog(logFile));
            return (Array.isArray(all) ? all : []).slice(-BACKLOG_LIMIT);
        },
        enabled: logFile !== null,
    });

    useEffect(() => {
        setLive([]);
        rowRefs.current.clear();

        if (!logFile) {
            setSseLive(false);
            return;
        }

        const es = new EventSource(paths.daemonRunTail(logFile));
        es.onopen = () => setSseLive(true);
        es.onmessage = (ev) => {
            setSseLive(true);

            try {
                const entry = SafeJSON.parse(ev.data, { strict: true }) as ClassifiedLogEntry;
                setLive((prev) => [...prev, entry]);
            } catch {
                // Malformed frame or the guard's error frame — non-actionable; keep streaming.
            }
        };
        es.onerror = () => {
            if (es.readyState === EventSource.CLOSED) {
                setSseLive(false);
            }
        };

        return () => es.close();
    }, [logFile]);

    const lines = useMemo<RenderLine[]>(() => {
        const merged = [...(backlogQuery.data ?? []), ...live];
        return merged.map((entry, index) => ({ index, cls: effClass(entry), text: lineText(entry) }));
    }, [backlogQuery.data, live]);

    const firstErrorIndex = useMemo(() => lines.findIndex((l) => l.cls === "error"), [lines]);

    useEffect(() => {
        if (autoScroll && listRef.current) {
            listRef.current.scrollTop = listRef.current.scrollHeight;
        }
    }, [lines.length, autoScroll]);

    const jumpToError = (): void => {
        if (firstErrorIndex < 0) {
            return;
        }

        setAutoScroll(false);
        rowRefs.current.get(firstErrorIndex)?.scrollIntoView({ behavior: "smooth", block: "center" });
    };

    if (logFile === null) {
        return (
            <div data-testid="build-log-tail-stream" className="dd-panel flex flex-1 items-center justify-center p-8 text-sm text-[var(--dd-text-muted)]">
                Pick a run to tail its log.
            </div>
        );
    }

    return (
        <div data-testid="build-log-tail-stream" className="dd-panel flex min-h-0 flex-1 flex-col p-4">
            <div className="mb-3 flex items-center justify-between">
                <div data-testid="build-log-tail-live-pill">
                    <LiveSseIndicator live={sseLive} count={lines.length} />
                </div>
                <div className="flex items-center gap-3">
                    {firstErrorIndex >= 0 ? (
                        <button
                            type="button"
                            data-testid="build-log-tail-jump-error"
                            onClick={jumpToError}
                            className="rounded border px-2 py-0.5 text-xs font-semibold transition-colors hover:border-[#f87171]"
                            style={{ borderColor: "var(--dd-border)", color: "#f87171" }}
                        >
                            jump to error
                        </button>
                    ) : null}
                    <button
                        type="button"
                        data-testid="build-log-tail-autoscroll-toggle"
                        onClick={() => setAutoScroll((v) => !v)}
                        className="rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest transition-colors"
                        style={{
                            borderColor: "var(--dd-border)",
                            color: autoScroll ? "var(--dd-accent-from)" : "var(--dd-text-muted)",
                        }}
                    >
                        {autoScroll ? "auto-scroll on" : "auto-scroll off"}
                    </button>
                </div>
            </div>

            {lines.length === 0 ? (
                <div data-testid="build-log-tail-empty" className="py-8 text-center text-sm text-[var(--dd-text-muted)]">
                    No log output yet…
                </div>
            ) : (
                <div
                    ref={listRef}
                    data-testid="build-log-tail-list"
                    className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto"
                    onWheel={() => setAutoScroll(false)}
                >
                    {lines.map((line) => {
                        const isError = line.cls === "error";

                        return (
                            <div
                                key={line.index}
                                ref={(el) => {
                                    if (el) {
                                        rowRefs.current.set(line.index, el);
                                    } else {
                                        rowRefs.current.delete(line.index);
                                    }
                                }}
                                data-testid={isError ? `build-log-tail-error-${line.index}` : `build-log-tail-line-${line.index}`}
                                className="whitespace-pre-wrap font-mono text-xs"
                                style={{ color: colorFor(line.cls), fontWeight: isError ? 700 : 400 }}
                            >
                                {line.text}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
