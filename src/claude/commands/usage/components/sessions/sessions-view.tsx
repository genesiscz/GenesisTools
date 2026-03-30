import { findClaudeCommand } from "@app/utils/claude";
import { formatRelativeTime, formatTokens } from "@app/utils/format";
import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationManager } from "../../../../lib/usage/notification-manager";
import { useScroll } from "../../hooks/use-scroll";
import { type SessionRow, useSessions } from "../../hooks/use-sessions";

// Module-level: survives component unmount/remount (tab switches)
let _savedSessionsOffset = 0;

const CACHE_STATUS_COLOR: Record<string, string> = {
    HOT: "green",
    COOLING: "yellow",
    CRITICAL: "red",
    COLD: "gray",
};

const CACHE_STATUS_LABEL: Record<string, string> = {
    HOT: "HOT    ",
    COOLING: "COOLING",
    CRITICAL: "CRIT   ",
    COLD: "COLD   ",
};

function formatTtl(sec: number): string {
    if (sec <= 0) {
        return "—      ";
    }

    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}  `;
}

function abbreviateModel(model: string | null): string {
    if (!model) {
        return "    ";
    }

    return model.slice(0, 4).padEnd(4);
}

type ActionMenuState = { open: false } | { open: true; sessionId: string; title: string | null };
type PingState = "idle" | "pinging" | "done" | "error";

interface SessionsViewProps {
    notifications?: NotificationManager | null;
}

export function SessionsView({ notifications }: SessionsViewProps) {
    const { stdout } = useStdout();
    const termHeight = stdout?.rows ?? 24;

    const { groups, flatRows, loading, timeFilter, cycleTimeFilter } = useSessions({ active: true, notifications });

    const [actionMenu, setActionMenu] = useState<ActionMenuState>({ open: false });
    const [pingStatuses, setPingStatuses] = useState<Map<string, PingState>>(new Map());
    const [claudeCmd, setClaudeCmd] = useState<string>("ccc");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const pingRef = useRef<Map<string, PingState>>(new Map());
    const pingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

    // Discover claude command once on mount
    useEffect(() => {
        findClaudeCommand()
            .then(setClaudeCmd)
            .catch(() => {});
    }, []);

    // Clean up ping timers on unmount
    useEffect(() => {
        return () => {
            for (const timer of pingTimersRef.current.values()) {
                clearTimeout(timer);
            }
        };
    }, []);

    // TabBar(1) + StatusBar(3) + paddingY(2) + hint(1) + colHeader(1) = 8 fixed lines
    // Each group header takes 1 line + marginTop(1) for non-first groups
    const separatorLines = groups.length > 0 ? groups.length + (groups.length - 1) : 0;
    const pageSize = Math.max(3, termHeight - 8 - separatorLines);

    const { offset, setOffset } = useScroll({
        totalItems: flatRows.length,
        pageSize,
        enabled: !actionMenu.open,
        initialOffset: _savedSessionsOffset,
    });

    useEffect(() => {
        _savedSessionsOffset = offset;
    }, [offset]);

    useEffect(() => {
        const max = Math.max(0, flatRows.length - pageSize);

        if (offset > max) {
            setOffset(max);
        }
    }, [flatRows.length, pageSize, offset, setOffset]);

    // Clamp selected index to valid range
    useEffect(() => {
        if (selectedIndex >= flatRows.length && flatRows.length > 0) {
            setSelectedIndex(flatRows.length - 1);
        }
    }, [flatRows.length, selectedIndex]);

    const pingSession = useCallback(
        async (sessionId: string) => {
            const update = (state: PingState) => {
                pingRef.current = new Map(pingRef.current).set(sessionId, state);
                setPingStatuses(new Map(pingRef.current));
            };

            update("pinging");

            const scheduleReset = (sid: string) => {
                const timer = setTimeout(() => {
                    const next = new Map(pingRef.current);
                    next.delete(sid);
                    pingRef.current = next;
                    setPingStatuses(new Map(next));
                    pingTimersRef.current.delete(sid);
                }, 3000);
                pingTimersRef.current.set(sid, timer);
            };

            try {
                const shell = process.env.SHELL ?? "/bin/sh";
                const proc = Bun.spawn({
                    cmd: [shell, "-ic", `${claudeCmd} --resume '${sessionId}' -p '.' --output-format json 2>/dev/null`],
                    stdio: ["ignore", "ignore", "ignore"],
                });
                const exitCode = await proc.exited;

                if (exitCode !== 0) {
                    update("error");
                } else {
                    update("done");
                }

                scheduleReset(sessionId);
            } catch {
                update("error");
                scheduleReset(sessionId);
            }
        },
        [claudeCmd]
    );

    useInput((input, key) => {
        if (actionMenu.open) {
            if (key.escape || input === "q") {
                setActionMenu({ open: false });
                return;
            }

            if (input === "1") {
                setActionMenu({ open: false });
                pingSession(actionMenu.sessionId);
                return;
            }

            if (input === "2") {
                const cmd = `${claudeCmd} --resume '${actionMenu.sessionId}'`;
                setActionMenu({ open: false });
                import("clipboardy").then((clipboard) => clipboard.default.write(cmd)).catch(() => {});
                return;
            }

            return;
        }

        if (input === "f") {
            cycleTimeFilter();
            return;
        }

        if (key.downArrow || input === "j") {
            setSelectedIndex((i) => Math.min(i + 1, Math.max(0, flatRows.length - 1)));
        }

        if (key.upArrow || input === "k") {
            setSelectedIndex((i) => Math.max(0, i - 1));
        }

        if (key.return) {
            const session = flatRows[selectedIndex];

            if (session) {
                setActionMenu({
                    open: true,
                    sessionId: session.sessionId,
                    title: session.title,
                });
            }
        }
    });

    if (loading && flatRows.length === 0) {
        return (
            <Box paddingX={1} paddingY={1}>
                <Text dimColor>{"Loading sessions..."}</Text>
            </Box>
        );
    }

    if (flatRows.length === 0) {
        return (
            <Box paddingX={1} paddingY={1}>
                <Text dimColor>{`No sessions found in last ${timeFilter}.  [f] cycle filter`}</Text>
            </Box>
        );
    }

    const maxHeight = Math.max(8, termHeight - 4);

    // Build flat display list with group headers interleaved
    interface DisplayEntry {
        type: "header" | "session";
        groupLabel?: string;
        session?: SessionRow;
        flatIndex?: number; // index in flatRows (for selection)
    }

    const displayEntries: DisplayEntry[] = [];
    let flatIdx = 0;

    for (const group of groups) {
        displayEntries.push({ type: "header", groupLabel: group.cwdShort });

        for (const session of group.sessions) {
            displayEntries.push({ type: "session", session, flatIndex: flatIdx++ });
        }
    }

    // Visible slice (scroll based on flatRows, but render with headers)
    const visibleSessions = flatRows.slice(offset, offset + pageSize);
    const visibleSessionIds = new Set(visibleSessions.map((s) => s.sessionId));

    const visibleEntries = displayEntries.filter((e) => {
        if (e.type === "session") {
            return visibleSessionIds.has(e.session!.sessionId);
        }

        // Include header if any of the group's sessions are visible
        return true; // handled during render
    });

    // Filter out headers with no visible sessions beneath them
    const filteredEntries: DisplayEntry[] = [];

    for (let i = 0; i < visibleEntries.length; i++) {
        const entry = visibleEntries[i];

        if (entry.type === "header") {
            const next = visibleEntries[i + 1];

            if (next && next.type === "session") {
                filteredEntries.push(entry);
            }
        } else {
            filteredEntries.push(entry);
        }
    }

    const rangeStart = flatRows.length > 0 ? offset + 1 : 0;
    const rangeEnd = Math.min(offset + pageSize, flatRows.length);
    const hint = `Showing last ${timeFilter}  [f] filter  [↑/↓] select  [Enter] actions  [j/k] scroll  (${rangeStart}-${rangeEnd} of ${flatRows.length})`;

    const colHeader = `${"Session".padEnd(42)}${"Model".padEnd(7)}${"Last Msg".padEnd(11)}${"Cache".padEnd(10)}${"TTL".padEnd(8)}${"Tokens".padEnd(9)}${"CacheR".padEnd(9)}CacheW`;

    return (
        <Box flexDirection="column" paddingX={1} paddingY={1} height={maxHeight} overflow="hidden">
            <Text dimColor>{hint}</Text>
            <Text bold>{colHeader}</Text>

            {filteredEntries.map((entry, i) => {
                if (entry.type === "header") {
                    return (
                        <Box key={`header-${entry.groupLabel}`} marginTop={i > 0 ? 1 : 0}>
                            <Text
                                bold
                            >{`── ${entry.groupLabel} ${"─".repeat(Math.max(2, 50 - (entry.groupLabel?.length ?? 0)))}`}</Text>
                        </Box>
                    );
                }

                const s = entry.session!;
                const isSelected = entry.flatIndex === selectedIndex;
                const pingState = pingStatuses.get(s.sessionId);
                const cacheColor = CACHE_STATUS_COLOR[s.cacheStatus] ?? "white";
                const sessionLabel = s.title
                    ? `${s.title.slice(0, 32)} (${s.sessionId.slice(0, 8)})`
                    : `(unnamed) (${s.sessionId.slice(0, 8)})`;

                let pingIndicator = "";

                if (pingState === "pinging") {
                    pingIndicator = " ⟳";
                } else if (pingState === "done") {
                    pingIndicator = " ✓";
                } else if (pingState === "error") {
                    pingIndicator = " ✗";
                }

                const modelLabel =
                    s.modelSwitched && s.model
                        ? `${abbreviateModel(s.model)}⚠`
                        : s.model
                          ? abbreviateModel(s.model)
                          : "    ";

                const lastMsg = formatRelativeTime(new Date(s.mtime), { compact: true });

                return (
                    <Box key={s.sessionId} flexDirection="row">
                        {isSelected && (
                            <Text color="cyan" bold>
                                {"▶ "}
                            </Text>
                        )}
                        {!isSelected && <Text>{"  "}</Text>}
                        <Text color={isSelected ? "cyan" : undefined}>{sessionLabel.padEnd(40).slice(0, 40)}</Text>
                        <Text color={s.modelSwitched ? "red" : "magenta"}>{`${modelLabel.padEnd(7)}`}</Text>
                        <Text dimColor>{lastMsg.padEnd(11)}</Text>
                        <Text color={cacheColor}>{CACHE_STATUS_LABEL[s.cacheStatus].padEnd(10)}</Text>
                        <Text color={cacheColor}>{formatTtl(s.cacheTtlSec).padEnd(8)}</Text>
                        <Text dimColor>{formatTokens(s.totalTokens).padEnd(9)}</Text>
                        <Text dimColor>{formatTokens(s.cacheReadTokens).padEnd(9)}</Text>
                        <Text dimColor>{formatTokens(s.cacheCreateTokens)}</Text>
                        {pingIndicator && (
                            <Text color={pingState === "done" ? "green" : pingState === "error" ? "red" : "yellow"}>
                                {pingIndicator}
                            </Text>
                        )}
                    </Box>
                );
            })}

            {actionMenu.open && (
                <Box
                    flexDirection="column"
                    borderStyle="round"
                    borderColor="cyan"
                    paddingX={2}
                    paddingY={0}
                    marginTop={1}
                >
                    <Text bold color="cyan">
                        {`Session: ${actionMenu.title?.slice(0, 50) ?? actionMenu.sessionId.slice(0, 8)}`}
                    </Text>
                    <Text>{"[1] Ping to keep warm"}</Text>
                    <Text>{`[2] Show resume command: ${claudeCmd} --resume ${actionMenu.sessionId}`}</Text>
                    <Text dimColor>{"[Esc/q] Cancel"}</Text>
                </Box>
            )}
        </Box>
    );
}
