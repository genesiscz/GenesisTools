#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { logger, out } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import { speak } from "@genesiscz/utils/macos/tts";
import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    type CommandTiming,
    listOpenFiles,
    nextSortBy,
    type OpenFile,
    type ProcessInfo,
    runRefreshCycle,
    type SortBy,
    sortProcesses,
    UNKNOWN_OPEN_FILES,
} from "./lib/process-data";
import Table, { type CellProps } from "./Table";

const DEFAULT_INTERVAL_SECONDS = 5;
const MAX_NOTIFICATIONS = 50;
const MAX_COMMAND_HISTORY = 10;
/** Terminal lines one process row occupies: its separator, plus a body row that wraps to two. */
const LINES_PER_ROW = 3;
/** Header, filter, controls, the window counter and the borders, whatever the row count. */
const CHROME_LINES = 15;
/** Never window below this, so a short terminal still shows a usable list. */
const MIN_VISIBLE_ROWS = 5;
/** How long a CPU alert suppresses the next one for the same process. */
const CPU_ALERT_REARM_MS = 30_000;
/** How long ANY CPU alert suppresses the next one, across all processes. */
const CPU_ALERT_COOLDOWN_MS = 60_000;
const MAX_FILES_LISTED = 30;

const HELP = `
macOS Resource Analyzer

Usage: tools macos-resources [options]

Options:
  -p, --process <name>     Filter processes by name or PID
  -c, --cpulimit <percent> Alert when CPU usage exceeds percentage
  -m, --memorylimit <MB>   Alert when memory usage exceeds MB
  -f, --fileslimit <count> Alert when open files exceed count
  -i, --interval <seconds> Refresh interval, default ${DEFAULT_INTERVAL_SECONDS}
  -n, --notify             Enable system notifications
  -s, --say                Enable voice notifications
  -h, --help               Show this help message

Controls:
  ↑↓ Navigate processes
  f  Toggle file view
  r  Refresh (also re-reads every open-file count)
  s  Toggle sort (CPU/Files/PID)
  q  Quit

Examples:
  tools macos-resources --cpulimit 80 --memorylimit 1000
  tools macos-resources --process chrome --notify
  tools macos-resources --fileslimit 100 --say
`;

export interface AppOptions {
    filter: string;
    cpuLimit: number | null;
    memoryLimit: number | null;
    filesLimit: number | null;
    notify: boolean;
    say: boolean;
    intervalMs: number;
}

interface Notification {
    id: string;
    timestamp: Date;
    message: string;
    type: "cpu" | "memory" | "files";
}

/** Parse argv into the options the app runs on. Pure: it neither reads argv nor exits. */
export function parseCliOptions(argv: string[]): AppOptions | "help" {
    const { values } = parseArgs({
        args: argv,
        options: {
            process: { type: "string", short: "p", default: "" },
            cpulimit: { type: "string", short: "c" },
            memorylimit: { type: "string", short: "m" },
            fileslimit: { type: "string", short: "f" },
            interval: { type: "string", short: "i" },
            notify: { type: "boolean", short: "n" },
            say: { type: "boolean", short: "s" },
            help: { type: "boolean", short: "h" },
        },
    });

    if (values.help) {
        return "help";
    }

    const interval = values.interval === undefined ? DEFAULT_INTERVAL_SECONDS : Number.parseFloat(values.interval);

    return {
        filter: values.process ?? "",
        cpuLimit: values.cpulimit === undefined ? null : Number.parseFloat(values.cpulimit),
        memoryLimit: values.memorylimit === undefined ? null : Number.parseFloat(values.memorylimit),
        filesLimit: values.fileslimit === undefined ? null : Number.parseInt(values.fileslimit, 10),
        notify: values.notify ?? false,
        say: values.say ?? false,
        intervalMs: Number.isFinite(interval) && interval > 0 ? interval * 1000 : DEFAULT_INTERVAL_SECONDS * 1000,
    };
}

/**
 * Hoisted, not written inline in the JSX. An array literal in a prop is a fresh
 * identity on every render, which defeats both `React.memo` on the table and the
 * column-width memo inside it — the two things that keep a repaint off the
 * critical path.
 */
const PROCESS_COLUMNS = ["pid", "process", "cpu", "memory", "files", "command"] as const;
const FILE_COLUMNS = ["fd", "type", "file"] as const;

function tableRows(processes: readonly ProcessInfo[], selectedIndex: number) {
    return processes.map((proc, index) => ({
        pid: `${index === selectedIndex ? ">" : " "}${proc.pid}`,
        process: proc.name.substring(0, 20),
        cpu: `${proc.cpu.toFixed(1)}%`,
        memory: `${proc.memoryMB.toFixed(0)}MB`,
        files: proc.openFiles === UNKNOWN_OPEN_FILES ? "?" : proc.openFiles.toString(),
        command: `${proc.command.substring(0, 60)}\n${proc.command.substring(60, 120)}`,
    }));
}

const MemoizedCell = React.memo(({ children, column }: CellProps) => {
    return (
        <Text color={column === 0 ? "green" : column === 2 ? "yellow" : column === 4 ? "cyan" : undefined}>
            {children}
        </Text>
    );
});

const NotificationsPanel = React.memo(({ notifications }: { notifications: Notification[] }) => {
    return (
        <Box flexDirection="column" width="25%" height="50" marginLeft={1} borderStyle="single">
            <Box marginBottom={1}>
                <Text bold color="yellow">
                    Notifications
                </Text>
            </Box>
            <Box flexDirection="column" overflow="hidden" height="100%">
                {notifications.map((notification) => (
                    <Box key={notification.id} marginBottom={0}>
                        <Text color="gray">{notification.timestamp.toLocaleTimeString()} </Text>
                        <Text color="white">{notification.message}</Text>
                    </Box>
                ))}
                {notifications.length === 0 && <Text color="gray">No notifications</Text>}
            </Box>
        </Box>
    );
});

const CommandPanel = React.memo(({ commandHistory }: { commandHistory: CommandTiming[] }) => {
    return (
        <Box flexDirection="column" width="25%" height="50%" marginLeft={1} borderStyle="single" overflow="hidden">
            <Box marginBottom={1}>
                <Text bold color="cyan">
                    Commands Performance
                </Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} overflow="hidden" height="95%">
                {commandHistory.length > 0 ? (
                    commandHistory.map((cmd) => (
                        <Box key={`${cmd.at.getTime()}-${cmd.command}`} marginBottom={0}>
                            <Text color="gray">{cmd.command} - </Text>
                            <Text color="white">{cmd.durationMs.toFixed(0)}ms</Text>
                        </Box>
                    ))
                ) : (
                    <Text color="gray">No commands executed yet</Text>
                )}
            </Box>
        </Box>
    );
});

const App: React.FC<{ options: AppOptions }> = ({ options }) => {
    const [processes, setProcesses] = useState<ProcessInfo[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [showFiles, setShowFiles] = useState(false);
    const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [commandHistory, setCommandHistory] = useState<CommandTiming[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [sortBy, setSortBy] = useState<SortBy>("cpu");
    const [cycle, setCycle] = useState(0);
    const { exit } = useApp();

    // Everything the poll reads lives in a ref. Reading it from state instead
    // would put it in the poll's dependency array, and since the poll SETS that
    // state each round the effect would tear down and restart its own interval
    // every round — which is the bug this rewrite exists to remove.
    const pollingRef = useRef(false);
    const processesRef = useRef<ProcessInfo[]>([]);
    const lastFilesUpdateRef = useRef<Map<number, number>>(new Map());
    const selectedPidRef = useRef<number | null>(null);
    const sortByRef = useRef<SortBy>("cpu");
    const forceFilesRef = useRef(false);

    // Alert bookkeeping is refs for the same reason: `checkAndAlert` writes all
    // three sets, so holding them in state would invalidate the callback on
    // every alert and restart the poll loop with it.
    const alertedCpuRef = useRef<Set<number>>(new Set());
    const alertedMemoryRef = useRef<Set<number>>(new Set());
    const alertedFilesRef = useRef<Set<number>>(new Set());
    const lastCpuAlertRef = useRef(0);
    const rearmTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

    const addNotification = useCallback((message: string, type: Notification["type"]) => {
        const notification: Notification = {
            id: `${Date.now()}-${Math.random()}`,
            timestamp: new Date(),
            message,
            type,
        };

        setNotifications((prev) => [notification, ...prev].slice(0, MAX_NOTIFICATIONS));
    }, []);

    const trackCommands = useCallback((timings: readonly CommandTiming[]) => {
        setCommandHistory((prev) => [...[...timings].reverse(), ...prev].slice(0, MAX_COMMAND_HISTORY));
    }, []);

    const raiseAlert = useCallback(
        (title: string, message: string, type: Notification["type"]) => {
            addNotification(message, type);

            if (options.say) {
                speak(message).catch((err) => logger.warn({ err }, "voice alert failed"));
            }

            if (options.notify) {
                sendNotification({ title, message }).catch((err) =>
                    logger.warn({ err }, "desktop notification failed")
                );
            }
        },
        [addNotification, options.notify, options.say]
    );

    const checkAndAlert = useCallback(
        (processList: readonly ProcessInfo[]) => {
            for (const proc of processList) {
                if (options.cpuLimit !== null && proc.cpu > options.cpuLimit && !alertedCpuRef.current.has(proc.pid)) {
                    const now = Date.now();

                    if (now - lastCpuAlertRef.current >= CPU_ALERT_COOLDOWN_MS) {
                        lastCpuAlertRef.current = now;
                        alertedCpuRef.current.add(proc.pid);
                        raiseAlert("High CPU Usage", `${proc.name} uses ${proc.cpu.toFixed(1)}% CPU`, "cpu");

                        const timer = setTimeout(() => {
                            alertedCpuRef.current.delete(proc.pid);
                            rearmTimersRef.current.delete(timer);
                        }, CPU_ALERT_REARM_MS);
                        rearmTimersRef.current.add(timer);
                    }
                }

                if (options.memoryLimit !== null) {
                    const over = proc.memoryMB > options.memoryLimit;
                    const alerted = alertedMemoryRef.current.has(proc.pid);

                    if (over && !alerted) {
                        alertedMemoryRef.current.add(proc.pid);
                        raiseAlert(
                            "High Memory Usage",
                            `${proc.name} uses ${proc.memoryMB.toFixed(0)}MB memory`,
                            "memory"
                        );
                    } else if (!over && alerted) {
                        alertedMemoryRef.current.delete(proc.pid);
                    }
                }

                if (options.filesLimit !== null && proc.openFiles !== UNKNOWN_OPEN_FILES) {
                    const over = proc.openFiles > options.filesLimit;
                    const alerted = alertedFilesRef.current.has(proc.pid);

                    if (over && !alerted) {
                        alertedFilesRef.current.add(proc.pid);
                        raiseAlert("High File Usage", `${proc.name} uses ${proc.openFiles} files`, "files");
                    } else if (!over && alerted) {
                        alertedFilesRef.current.delete(proc.pid);
                    }
                }
            }
        },
        [options.cpuLimit, options.memoryLimit, options.filesLimit, raiseAlert]
    );

    const poll = useCallback(async () => {
        if (pollingRef.current) {
            return;
        }

        pollingRef.current = true;

        const publish = (list: ProcessInfo[]) => {
            processesRef.current = list;

            const previousPid = selectedPidRef.current;
            const found = previousPid === null ? 0 : list.findIndex((p) => p.pid === previousPid);
            const index = found === -1 ? 0 : found;
            selectedPidRef.current = list[index]?.pid ?? null;

            setSelectedIndex(index);
            setProcesses(list);
            setIsLoading(false);
        };

        try {
            const result = await runRefreshCycle({
                filter: options.filter,
                sortBy: sortByRef.current,
                previous: processesRef.current,
                lastFilesUpdate: lastFilesUpdateRef.current,
                selectedPid: selectedPidRef.current,
                forceFiles: forceFilesRef.current,
                // Paint the table as soon as `ps` answers. The open-files sweep
                // behind it reads every process on the machine on the first round
                // and takes seconds; waiting for it would hold the first frame.
                onProcesses: publish,
            });

            forceFilesRef.current = false;
            lastFilesUpdateRef.current = result.lastFilesUpdate;

            publish(result.processes);
            setCycle((n) => n + 1);
            trackCommands(result.commands);
            checkAndAlert(result.processes);
        } catch (err) {
            logger.error({ err }, "macos-resources refresh cycle failed");
            addNotification(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`, "cpu");
        } finally {
            pollingRef.current = false;
        }
    }, [options.filter, addNotification, checkAndAlert, trackCommands]);

    useEffect(() => {
        void poll();
    }, [poll]);

    useEffect(() => {
        const interval = setInterval(() => void poll(), options.intervalMs);

        return () => clearInterval(interval);
    }, [poll, options.intervalMs]);

    useEffect(() => {
        const timers = rearmTimersRef.current;

        return () => {
            // A pending re-arm timer keeps the event loop alive after `q`, so the
            // process would sit there for up to 30 seconds looking hung.
            for (const timer of timers) {
                clearTimeout(timer);
            }

            timers.clear();
        };
    }, []);

    const selectedPid = processes[selectedIndex]?.pid ?? null;

    useEffect(() => {
        if (!showFiles || selectedPid === null) {
            return;
        }

        let cancelled = false;

        listOpenFiles(selectedPid)
            .then((result) => {
                if (cancelled) {
                    return;
                }

                setOpenFiles(result.files);
                trackCommands([result.timing]);
            })
            .catch((err) => logger.warn({ err, pid: selectedPid }, "listing open files failed"));

        return () => {
            cancelled = true;
        };
        // `cycle` keeps the listing fresh once per refresh while the view is open.
        // Depending on `processes` instead would re-run it on every render.
    }, [showFiles, selectedPid, cycle, trackCommands]);

    useInput((input, key) => {
        if (input === "q") {
            exit();
            return;
        }

        if (input === "f") {
            setShowFiles((prev) => !prev);
            return;
        }

        if (input === "r") {
            forceFilesRef.current = true;
            addNotification("Refresh triggered", "cpu");
            void poll();
            return;
        }

        if (input === "s") {
            const next = nextSortBy(sortByRef.current);
            sortByRef.current = next;
            setSortBy(next);
            addNotification(`Sort changed to ${next}`, "cpu");
            setProcesses((prev) => {
                const sorted = sortProcesses(prev, next);
                processesRef.current = sorted;
                const index = sorted.findIndex((p) => p.pid === selectedPidRef.current);
                setSelectedIndex(index === -1 ? 0 : index);
                return sorted;
            });
            return;
        }

        if (key.upArrow || key.downArrow) {
            const delta = key.upArrow ? -1 : 1;
            const index = Math.min(Math.max(0, selectedIndex + delta), Math.max(0, processes.length - 1));
            selectedPidRef.current = processes[index]?.pid ?? null;
            setSelectedIndex(index);
            return;
        }

        if (key.escape && showFiles) {
            setShowFiles(false);
        }
    });

    // The table costs three terminal lines per process (a separator, and a body row whose command
    // cell wraps to two). Rendering every process therefore asks Ink to diff and repaint thousands
    // of lines per refresh: at ~2100 processes that measured 70% of a core and 3.2 GB of heap,
    // against 4% and 149 MB for the same data before this file was rewritten. Only the rows that
    // fit are built, which also bounds the column-width scan and makes the arrow keys usable.
    const { stdout } = useStdout();
    const visibleRows = Math.max(MIN_VISIBLE_ROWS, Math.floor(((stdout?.rows ?? 24) - CHROME_LINES) / LINES_PER_ROW));
    const windowStart = Math.min(
        Math.max(0, selectedIndex - Math.floor(visibleRows / 2)),
        Math.max(0, processes.length - visibleRows)
    );
    const windowed = useMemo(
        () => processes.slice(windowStart, windowStart + visibleRows),
        [processes, windowStart, visibleRows]
    );
    const rows = useMemo(
        () => tableRows(windowed, selectedIndex - windowStart),
        [windowed, selectedIndex, windowStart]
    );
    const fileRows = useMemo(
        () =>
            openFiles.slice(0, MAX_FILES_LISTED).map((file) => ({
                fd: file.fd,
                type: file.type,
                file: file.name.substring(0, 50),
            })),
        [openFiles]
    );

    const renderHeader = useCallback(
        (props: React.PropsWithChildren) => {
            const headerText = String(props.children);
            let indicator = "";
            let color = "blue";

            if (headerText === "pid" && sortBy === "pid") {
                indicator = " ↓";
                color = "green";
            } else if (headerText === "cpu" && sortBy === "cpu") {
                indicator = " ↓";
                color = "yellow";
            } else if (headerText === "files" && sortBy === "files") {
                indicator = " ↓";
                color = "cyan";
            }

            return (
                <Text bold color={color}>
                    {headerText}
                    {indicator}
                </Text>
            );
        },
        [sortBy]
    );

    const renderCell = useCallback(
        (props: CellProps) => <MemoizedCell column={props.column}>{props.children}</MemoizedCell>,
        []
    );

    return (
        <Box flexDirection="column" width="100%" height="100%">
            <Box flexDirection="row">
                <Box flexDirection="column" width="33%" minWidth="50" borderStyle="single">
                    <Box marginBottom={1}>
                        <Text bold color="cyan">
                            macOS Resource Analyzer
                        </Text>
                        <Text color="gray">
                            {" "}
                            Total Processes: {processes.length} | Updated: {new Date().toLocaleTimeString()}
                        </Text>
                    </Box>

                    <Box marginBottom={1}>
                        <Text color="gray">
                            Filter: {options.filter || "All processes"}
                            {options.cpuLimit !== null && ` | CPU Limit: ${options.cpuLimit}%`}
                            {options.memoryLimit !== null && ` | Memory Limit: ${options.memoryLimit}MB`}
                            {options.filesLimit !== null && ` | Files Limit: ${options.filesLimit}`}
                            {` | Sort: ${sortBy.toUpperCase()}`}
                        </Text>
                    </Box>

                    <Box marginBottom={1}>
                        <Text color="gray">
                            Controls: ↑↓ Navigate | f: Toggle files | r: Refresh | s: Sort (CPU/Files/PID) | q: Quit
                        </Text>
                    </Box>

                    {!showFiles ? (
                        isLoading ? (
                            <Box justifyContent="center" alignItems="center" height={10}>
                                <Text color="yellow">Loading processes...</Text>
                            </Box>
                        ) : (
                            <Box flexDirection="column" width="100%" borderStyle="single">
                                <Box>
                                    <Text color="gray">
                                        {`rows ${processes.length === 0 ? 0 : windowStart + 1}-${Math.min(processes.length, windowStart + visibleRows)} of ${processes.length}`}
                                    </Text>
                                </Box>
                                <Table data={rows} columns={PROCESS_COLUMNS} header={renderHeader} cell={renderCell} />
                            </Box>
                        )
                    ) : (
                        <>
                            <Box marginBottom={1}>
                                <Text bold color="yellow">
                                    Open Files for PID {processes[selectedIndex]?.pid} ({processes[selectedIndex]?.name}
                                    )
                                </Text>
                            </Box>

                            <Table data={fileRows} columns={FILE_COLUMNS} />

                            {openFiles.length > MAX_FILES_LISTED && (
                                <Box marginTop={1}>
                                    <Text color="gray">... and {openFiles.length - MAX_FILES_LISTED} more files</Text>
                                </Box>
                            )}
                        </>
                    )}
                </Box>

                <NotificationsPanel notifications={notifications} />
                <CommandPanel commandHistory={commandHistory} />
            </Box>
        </Box>
    );
};

export default App;

if (import.meta.main) {
    const options = parseCliOptions(process.argv.slice(2));

    if (options === "help") {
        out.print(HELP);
        process.exit(0);
    }

    render(<App options={options} />, {
        exitOnCtrlC: false,
        patchConsole: false,
        isScreenReaderEnabled: false,
        maxFps: 30,
        stdout: process.stdout,
        stdin: process.stdin,
        stderr: process.stderr,
    });
}
