#!/usr/bin/env bun

import { exec } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { Box, render, Text, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useState } from "react";
import Table from "./Table";

const execAsync = promisify(exec);

// Parse command line arguments
const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        process: {
            type: "string",
            short: "p",
            default: "",
        },
        cpulimit: {
            type: "string",
            short: "c",
        },
        memorylimit: {
            type: "string",
            short: "m",
        },
        fileslimit: {
            type: "string",
            short: "f",
        },
        notify: {
            type: "boolean",
            short: "n",
        },
        say: {
            type: "boolean",
            short: "s",
        },
        help: {
            type: "boolean",
            short: "h",
        },
    },
});

// Show help if requested
if (values.help) {
    console.log(`
macOS Resource Analyzer

Usage: tools macos-resources [options]

Options:
  -p, --process <name>     Filter processes by name or PID
  -c, --cpulimit <percent> Alert when CPU usage exceeds percentage
  -m, --memorylimit <MB>   Alert when memory usage exceeds MB
  -f, --fileslimit <count> Alert when open files exceed count
  -n, --notify             Enable system notifications
  -s, --say                Enable voice notifications
  -h, --help               Show this help message

Controls:
  ↑↓ Navigate processes
  f  Toggle file view
  r  Refresh
  s  Toggle sort (CPU/PID/Files)
  q  Quit

Examples:
  tools macos-resources --cpulimit 80 --memorylimit 1000
  tools macos-resources --process chrome --notify
  tools macos-resources --fileslimit 100 --say
`);
    process.exit(0);
}

const processFilter = values.process || "";
const cpuLimit = values.cpulimit ? parseFloat(values.cpulimit) : null;
const memoryLimit = values.memorylimit ? parseFloat(values.memorylimit) : null;
const filesLimit = values.fileslimit ? parseInt(values.fileslimit, 10) : null;
const enableNotify = values.notify || false;
const enableSay = values.say || false;

interface ProcessInfo {
    pid: number;
    name: string;
    cpu: number;
    memory: number;
    memoryMB: number;
    openFiles: number;
    command: string;
}

interface OpenFile {
    name: string;
    type: string;
    fd: string;
}

interface Notification {
    id: string;
    timestamp: Date;
    message: string;
    type: "cpu" | "memory" | "files";
}

interface CommandPerformance {
    command: string;
    duration: number;
    timestamp: Date;
}

// Custom Table component using Ink's Box and Text
// const Table: React.FC<{
//     data: Array<Record<string, string>>;
//     columns: Array<{ key: string; header: string; width: number }>;
// }> = ({ data, columns }) => {
//     return (
//         <Box flexDirection="column">
//             {/* Header */}
//             <Box marginBottom={1}>
//                 <Text bold>{columns.map((col) => col.header.padEnd(col.width)).join(" ")}</Text>
//             </Box>

//             {/* Rows */}
//             {data.map((row, index) => (
//                 <Box key={index}>
//                     <Text>{columns.map((col) => row[col.key].padEnd(col.width)).join(" ")}</Text>
//                 </Box>
//             ))}
//         </Box>
//     );
// };

// Helper function to generate table data
const generateTableData = (processes: ProcessInfo[], selectedIndex: number) => {
    return processes.map((proc, index) => ({
        pid: `${index === selectedIndex ? ">" : " "}${proc.pid}`,
        process: proc.name.substring(0, 20),
        cpu: `${proc.cpu.toFixed(1)}%`,
        memory: `${proc.memoryMB.toFixed(0)}MB`,
        files: proc.openFiles === -1 ? "?" : proc.openFiles.toString(),
        command: `${proc.command.substring(0, 60)}\n${proc.command.substring(60, 120)}`, // Increased from 30 to 60 characters
    }));
};

// Memoized header component
const MemoizedHeader = React.memo(
    ({ children, sortBy }: { children: React.ReactNode; sortBy: "cpu" | "pid" | "files" }) => {
        const headerText = String(children);
        let sortIndicator = "";
        let color = "blue";

        if (headerText === "pid" && sortBy === "pid") {
            sortIndicator = " ↓";
            color = "green";
        } else if (headerText === "cpu" && sortBy === "cpu") {
            sortIndicator = " ↓";
            color = "yellow";
        } else if (headerText === "files" && sortBy === "files") {
            sortIndicator = " ↓";
            color = "cyan";
        }

        return (
            <Text bold color={color}>
                {headerText}
                {sortIndicator}
            </Text>
        );
    }
);

// Memoized cell component
const MemoizedCell = React.memo(({ children, column }: { children: React.ReactNode; column: number }) => {
    return (
        <Text color={column === 0 ? "green" : column === 2 ? "yellow" : column === 4 ? "cyan" : undefined}>
            {children}
        </Text>
    );
});

// Memoized notifications panel
const MemoizedNotificationsPanel = React.memo(({ notifications }: { notifications: Notification[] }) => {
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

// Memoized command performance panel
const MemoizedCommandPanel = React.memo(({ commandHistory }: { commandHistory: CommandPerformance[] }) => {
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
                        <Box key={`${cmd.timestamp.getTime()}-${cmd.command}`} marginBottom={0}>
                            <Text color="gray">{cmd.command} - </Text>
                            <Text color="white">{cmd.duration.toFixed(0)}ms</Text>
                        </Box>
                    ))
                ) : (
                    <Text color="gray">No commands executed yet</Text>
                )}
            </Box>
        </Box>
    );
});

// Component for displaying process list
const ProcessList: React.FC<{
    processes: ProcessInfo[];
    selectedIndex: number;
    showFiles: boolean;
    openFiles: OpenFile[];
    notifications: Notification[];
    commandHistory: CommandPerformance[];
    isLoading: boolean;
    sortBy: "cpu" | "pid" | "files";
}> = ({ processes, selectedIndex, showFiles, openFiles, notifications, commandHistory, isLoading, sortBy }) => {
    return (
        <Box flexDirection="column" width="100%" height="100%">
            {/* Top row with main content and notifications */}
            <Box flexDirection="row">
                {/* Main content area */}
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
                            Filter: {processFilter || "All processes"}
                            {cpuLimit && ` | CPU Limit: ${cpuLimit}%`}
                            {memoryLimit && ` | Memory Limit: ${memoryLimit}MB`}
                            {filesLimit && ` | Files Limit: ${filesLimit}`}
                            {` | Sort: ${sortBy.toUpperCase()}`}
                        </Text>
                    </Box>

                    <Box marginBottom={1}>
                        <Text color="gray">
                            Controls: ↑↓ Navigate | f: Toggle files | r: Refresh | s: Sort (CPU/PID/Files) | q: Quit
                        </Text>
                    </Box>

                    {!showFiles ? (
                        isLoading ? (
                            <Box justifyContent="center" alignItems="center" height={10}>
                                <Text color="yellow">Loading processes...</Text>
                            </Box>
                        ) : (
                            <Box flexDirection="column" width="100%" borderStyle="single">
                                <Table
                                    data={generateTableData(processes, selectedIndex)}
                                    columns={["pid", "process", "cpu", "memory", "files", "command"]}
                                    header={(props) => (
                                        <MemoizedHeader sortBy={sortBy}>{props.children}</MemoizedHeader>
                                    )}
                                    cell={(props) => (
                                        <MemoizedCell column={props.column}>{props.children}</MemoizedCell>
                                    )}
                                />
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

                            <Table
                                data={openFiles.slice(0, 30).map((file) => ({
                                    fd: file.fd,
                                    type: file.type,
                                    file: file.name.substring(0, 50),
                                }))}
                                columns={["fd", "type", "file"]}
                            />

                            {openFiles.length > 30 && (
                                <Box marginTop={1}>
                                    <Text color="gray">... and {openFiles.length - 30} more files</Text>
                                </Box>
                            )}
                        </>
                    )}
                </Box>

                {/* Notifications panel */}
                <MemoizedNotificationsPanel notifications={notifications} />

                {/* Command performance panel */}
                <MemoizedCommandPanel commandHistory={commandHistory} />
            </Box>
        </Box>
    );
};

// Main App Component
const App: React.FC = () => {
    const [processes, setProcesses] = useState<ProcessInfo[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [selectedPid, setSelectedPid] = useState<number | null>(null);
    const [showFiles, setShowFiles] = useState(false);
    const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
    const [alertedProcesses, setAlertedProcesses] = useState<Set<number>>(new Set());
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [alertedMemoryProcesses, setAlertedMemoryProcesses] = useState<Set<number>>(new Set());
    const [alertedFilesProcesses, setAlertedFilesProcesses] = useState<Set<number>>(new Set());
    const [commandHistory, setCommandHistory] = useState<CommandPerformance[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [lastFilesUpdate, setLastFilesUpdate] = useState<Map<number, number>>(new Map());
    const [lastCpuAlert, setLastCpuAlert] = useState<number>(0);
    const [sortBy, setSortBy] = useState<"cpu" | "pid" | "files">("cpu");
    const { exit } = useApp();

    // Helper function to add notifications
    const addNotification = useCallback((message: string, type: "cpu" | "memory" | "files") => {
        const notification: Notification = {
            id: `${Date.now()}-${Math.random()}`,
            timestamp: new Date(),
            message,
            type,
        };
        setNotifications((prev) => [notification, ...prev].slice(50)); // Keep last 50 notifications
    }, []);

    // Helper function to send system notification
    const sendSystemNotification = useCallback((title: string, message: string) => {
        exec(`osascript -e 'display notification "${message}" with title "${title}"'`);
    }, []);

    // Helper function to track command performance
    const trackCommand = useCallback((command: string, duration: number) => {
        const perf: CommandPerformance = {
            command,
            duration,
            timestamp: new Date(),
        };

        setCommandHistory((prev) => [perf, ...prev].slice(10)); // Keep last 100 commands, newest first
    }, []);

    // Background function to update open files count
    const updateOpenFilesCount = useCallback(
        async (processList: ProcessInfo[], forceRefresh: boolean = false) => {
            const now = Date.now();

            for (const proc of processList) {
                if (proc.pid > 100 && !proc.name.includes("kernel")) {
                    const lastUpdate = lastFilesUpdate.get(proc.pid) || 0;

                    // Update if: force refresh, no file count yet, or 60+ seconds since last update
                    if (forceRefresh || proc.openFiles === -1 || now - lastUpdate >= 60000) {
                        try {
                            const lsofStartTime = Date.now();
                            execAsync(`lsof -p ${proc.pid} 2>/dev/null | wc -l`).then((res) => {
                                const lsofDuration = Date.now() - lsofStartTime;
                                trackCommand(`lsof -p ${proc.pid} | wc -l`, lsofDuration);

                                addNotification(`Lsof ${proc.pid} is ${res.stdout.trim()}`, "files");

                                // Update the process with new file count
                                setProcesses((prev) =>
                                    prev.map((p) =>
                                        p.pid === proc.pid
                                            ? { ...p, openFiles: parseInt(res.stdout.trim(), 10) - 1 }
                                            : p
                                    )
                                );

                                // Update the last update time for this specific PID
                                setLastFilesUpdate((prev) => {
                                    const newMap = new Map(prev);
                                    newMap.set(proc.pid, now);
                                    return newMap;
                                });
                            });
                        } catch (e) {
                            addNotification(
                                `Error getting open files for ${proc.name}: ${
                                    e instanceof Error ? e.message : String(e)
                                }`,
                                "files"
                            );
                            // Process might have ended or permission denied
                        }
                    }
                }
            }
        },
        [lastFilesUpdate, trackCommand, addNotification]
    );

    // Function to get process information
    const getProcesses = useCallback(
        async (preserveFileCounts: boolean = false, currentProcesses: ProcessInfo[] = []): Promise<ProcessInfo[]> => {
            try {
                addNotification("getProcesses", "cpu");
                // Get process list with CPU and memory info - limit initial results for faster startup
                const psCommand = processFilter ? `ps aux | grep -i "${processFilter}" | grep -v grep ` : "ps aux ";

                const startTime = Date.now();
                const { stdout, stderr } = await execAsync(psCommand);
                const duration = Date.now() - startTime;
                trackCommand(`ps aux${processFilter ? ` | grep -i "${processFilter}"` : ""}`, duration);

                if (stderr) {
                    addNotification(`ps command stderr: ${stderr}`, "cpu");
                }
                const lines = stdout
                    .trim()
                    .split("\n")
                    .filter((line) => line);

                addNotification(`ps returned ${lines.length} lines`, "cpu");
                if (lines.length <= 1) {
                    addNotification("No processes found", "cpu");
                    return [];
                }

                const processList: ProcessInfo[] = [];

                for (const line of lines.slice(1)) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length < 11) {
                        continue;
                    }

                    const pid = parseInt(parts[1], 10);
                    const cpu = parseFloat(parts[2]);
                    const memory = parseFloat(parts[3]);
                    const _vsz = parseInt(parts[4], 10) / 1024; // Convert to MB
                    const rss = parseInt(parts[5], 10) / 1024; // Convert to MB
                    const command = parts.slice(10).join(" ");
                    const name = parts[10].split("/").pop() || parts[10];

                    // Skip if processFilter is a number (PID) and doesn't match
                    if (processFilter && !Number.isNaN(Number(processFilter))) {
                        if (pid !== parseInt(processFilter, 10)) {
                            continue;
                        }
                    }
                    // Skip if processFilter is a string and doesn't match
                    else if (
                        processFilter &&
                        !name.toLowerCase().includes(processFilter.toLowerCase()) &&
                        !command.toLowerCase().includes(processFilter.toLowerCase())
                    ) {
                        continue;
                    }

                    // Preserve existing file count or set placeholder
                    let openFilesCount = -1; // Default placeholder
                    if (preserveFileCounts) {
                        const existingProcess = currentProcesses.find((p) => p.pid === pid);
                        if (existingProcess && existingProcess.openFiles !== -1) {
                            openFilesCount = existingProcess.openFiles;
                        }
                    }

                    processList.push({
                        pid,
                        name,
                        cpu,
                        memory,
                        memoryMB: rss,
                        openFiles: openFilesCount,
                        command,
                    });
                }

                // Sort by CPU usage, PID, or files based on preference
                const sortedProcesses = processList.sort((a, b) => {
                    if (sortBy === "files") {
                        return b.openFiles - a.openFiles; // Descending order
                    } else if (sortBy === "cpu") {
                        return b.cpu - a.cpu;
                    } else {
                        return a.pid - b.pid;
                    }
                });

                addNotification(`Processed ${sortedProcesses.length} processes`, "cpu");
                return sortedProcesses;
            } catch (error) {
                console.error("Error getting processes:", error);
                return [];
            }
        },
        [trackCommand, sortBy, addNotification]
    );

    // Function to get open files for a specific process
    const getOpenFiles = useCallback(
        async (pid: number): Promise<OpenFile[]> => {
            try {
                const startTime = Date.now();
                const { stdout } = await execAsync(`lsof -p ${pid} 2>/dev/null`);
                const duration = Date.now() - startTime;
                trackCommand(`lsof -p ${pid}`, duration);
                const lines = stdout
                    .trim()
                    .split("\n")
                    .filter((line) => line);

                if (lines.length <= 1) {
                    return [];
                }

                const files: OpenFile[] = [];

                for (const line of lines.slice(1)) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length < 9) {
                        continue;
                    }

                    const fd = parts[3];
                    const type = parts[4];
                    const name = parts.slice(8).join(" ");

                    files.push({ fd, type, name });
                }

                // Sort by type, then by name
                return files.sort((a, b) => {
                    if (a.type !== b.type) {
                        return a.type.localeCompare(b.type);
                    }
                    return a.name.localeCompare(b.name);
                });
            } catch {
                return [];
            }
        },
        [trackCommand]
    );

    // Check for resource limit violations and alert
    const checkAndAlert = useCallback(
        async (processList: ProcessInfo[]) => {
            for (const proc of processList) {
                // CPU alerts - only if cpulimit is set, max 1 per minute
                if (cpuLimit && proc.cpu > cpuLimit && !alertedProcesses.has(proc.pid)) {
                    const now = Date.now();
                    if (now - lastCpuAlert >= 60000) {
                        // Only alert once per minute
                        setLastCpuAlert(now);
                        setAlertedProcesses((prev) => new Set([...prev, proc.pid]));
                        const message = `${proc.name} uses ${proc.cpu.toFixed(1)}% CPU`;

                        if (enableSay) {
                            exec(`say "${message}"`);
                        }
                        if (enableNotify) {
                            sendSystemNotification("High CPU Usage", message);
                        }
                        addNotification(message, "cpu");

                        // Remove from alerted after 30 seconds to allow re-alerting
                        setTimeout(() => {
                            setAlertedProcesses((prev) => {
                                const newSet = new Set(prev);
                                newSet.delete(proc.pid);
                                return newSet;
                            });
                        }, 30000);
                    }
                }

                // Memory alerts - only if memorylimit is set, and only once until memory goes down
                if (memoryLimit && proc.memoryMB > memoryLimit && !alertedMemoryProcesses.has(proc.pid)) {
                    setAlertedMemoryProcesses((prev) => new Set([...prev, proc.pid]));
                    const message = `${proc.name} uses ${proc.memoryMB.toFixed(0)}MB memory`;

                    if (enableSay) {
                        exec(`say "${message}"`);
                    }
                    if (enableNotify) {
                        sendSystemNotification("High Memory Usage", message);
                    }
                    addNotification(message, "memory");
                } else if (memoryLimit && proc.memoryMB <= memoryLimit && alertedMemoryProcesses.has(proc.pid)) {
                    // Remove from alerted memory processes when memory goes back down
                    setAlertedMemoryProcesses((prev) => {
                        const newSet = new Set(prev);
                        newSet.delete(proc.pid);
                        return newSet;
                    });
                }

                // Files alerts - only if fileslimit is set, and only once until files go down
                if (filesLimit && proc.openFiles > filesLimit && !alertedFilesProcesses.has(proc.pid)) {
                    setAlertedFilesProcesses((prev) => new Set([...prev, proc.pid]));
                    const message = `${proc.name} uses ${proc.openFiles} files`;

                    if (enableSay) {
                        exec(`say "${message}"`);
                    }
                    if (enableNotify) {
                        sendSystemNotification("High File Usage", message);
                    }
                    addNotification(message, "files");
                } else if (filesLimit && proc.openFiles <= filesLimit && alertedFilesProcesses.has(proc.pid)) {
                    // Remove from alerted files processes when files go back down
                    setAlertedFilesProcesses((prev) => {
                        const newSet = new Set(prev);
                        newSet.delete(proc.pid);
                        return newSet;
                    });
                }
            }
        },
        [
            alertedProcesses,
            alertedMemoryProcesses,
            alertedFilesProcesses,
            addNotification,
            sendSystemNotification,
            lastCpuAlert,
        ]
    );

    // Update processes periodically
    useEffect(() => {
        const updateProcesses = async () => {
            addNotification("Starting process update", "cpu");
            const procs = await getProcesses(true, processes); // Preserve file counts
            addNotification(`Got ${procs.length} processes`, "cpu");

            // Preserve selection by PID if we have a selected process
            if (selectedPid !== null) {
                const newIndex = procs.findIndex((p) => p.pid === selectedPid);
                if (newIndex !== -1) {
                    setSelectedIndex(newIndex);
                } else {
                    // Selected process no longer exists, reset to first
                    setSelectedIndex(0);
                    setSelectedPid(procs[0]?.pid || null);
                }
            } else {
                // No selection yet, select first process
                setSelectedPid(procs[0]?.pid || null);
            }

            setProcesses(procs);
            setIsLoading(false); // Clear loading state after first update
            addNotification("Loading state cleared", "cpu");
            await checkAndAlert(procs);
            // Update open files count in background - force refresh every minute, otherwise only update missing ones
            updateOpenFilesCount(procs, false);
        };

        updateProcesses();
        const interval = setInterval(updateProcesses, 5000); // Update every 1 second for better responsiveness

        return () => clearInterval(interval);
    }, [getProcesses, checkAndAlert, updateOpenFilesCount, selectedPid, addNotification, processes]);

    // Load open files when showing files view
    useEffect(() => {
        if (showFiles && processes[selectedIndex]) {
            getOpenFiles(processes[selectedIndex].pid).then(setOpenFiles);
        }
    }, [showFiles, selectedIndex, processes, getOpenFiles]);

    // Handle keyboard input
    useInput((input, key) => {
        if (input === "q") {
            exit();
        }

        if (input === "f") {
            setShowFiles(!showFiles);
        }

        if (input === "r") {
            addNotification("Refresh triggered", "cpu");
            // Clear screen to prevent scrolling issues
            // process.stdout.write("\x1B[2J\x1B[0f");
            getProcesses(true, processes).then((procs) => {
                // Preserve file counts and selection
                setProcesses(procs);
                // Ensure selected index is still valid
                if (selectedIndex >= procs.length) {
                    setSelectedIndex(Math.max(0, procs.length - 1));
                }
                checkAndAlert(procs);
            });
        }

        if (input === "s") {
            const newSortBy = sortBy === "files" ? "pid" : sortBy === "cpu" ? "files" : "cpu";
            addNotification(`Sort changed to ${newSortBy}`, "cpu");
            // Clear screen to prevent scrolling issues
            // process.stdout.write("\x1B[2J\x1B[0f");
            setSortBy(newSortBy);
        }

        if (key.upArrow) {
            const newIndex = Math.max(0, selectedIndex - 1);
            setSelectedIndex(newIndex);
            setSelectedPid(processes[newIndex]?.pid || null);
        }

        if (key.downArrow) {
            const newIndex = Math.min(processes.length - 1, selectedIndex + 1);
            setSelectedIndex(newIndex);
            setSelectedPid(processes[newIndex]?.pid || null);
        }

        if (key.escape) {
            if (showFiles) {
                setShowFiles(false);
            }
        }
    });

    return (
        <ProcessList
            processes={processes}
            selectedIndex={selectedIndex}
            showFiles={showFiles}
            openFiles={openFiles}
            notifications={notifications}
            commandHistory={commandHistory}
            isLoading={isLoading}
            sortBy={sortBy}
        />
    );
};

// Render the app
render(<App />, {
    exitOnCtrlC: false,
    // debug: true,
    patchConsole: false,
    isScreenReaderEnabled: false,
    maxFps: 30,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
});
