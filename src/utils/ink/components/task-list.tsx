/**
 * TaskList — Live task list with timers, spinners, and nested sub-tasks.
 *
 * Each task shows a status icon, label, and duration. Running tasks display
 * a spinner with live elapsed time. Children are indented with tree characters.
 *
 * Usage:
 *   <TaskList tasks={[
 *     { label: 'Build API', status: 'success', duration: 4200 },
 *     { label: 'Build Web', status: 'running', children: [
 *       { label: 'Compile TypeScript', status: 'success', duration: 1200 },
 *       { label: 'Bundle assets', status: 'running' },
 *     ]},
 *     { label: 'Push images', status: 'pending' },
 *   ]} />
 */

import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useElapsedTimer } from "../hooks/use-elapsed-timer.js";
import { formatDuration } from "../lib/format.js";
import { symbols, theme } from "../lib/theme.js";

export interface TaskItem {
    label: string;
    status: "pending" | "running" | "success" | "error";
    duration?: number;
    error?: string;
    children?: TaskItem[];
}

interface TaskListProps {
    tasks: TaskItem[];
}

function TaskIcon({ status }: { status: TaskItem["status"] }) {
    switch (status) {
        case "success":
            return <Text color={theme.success}>{symbols.success}</Text>;
        case "running":
            return (
                <Text color={theme.primary}>
                    <Spinner type="dots" />
                </Text>
            );
        case "error":
            return <Text color={theme.error}>{symbols.error}</Text>;
        default:
            return <Text color={theme.muted}>{symbols.pending}</Text>;
    }
}

function TaskRow({ task }: { task: TaskItem }) {
    const elapsed = useElapsedTimer({ active: task.status === "running" });

    const labelColor =
        task.status === "error"
            ? theme.error
            : task.status === "success"
              ? undefined // default white
              : task.status === "running"
                ? undefined
                : theme.muted;

    return (
        <Box flexDirection="column">
            <Box>
                <TaskIcon status={task.status} />
                <Text> </Text>
                <Text color={labelColor}>{task.label}</Text>
                {task.status === "running" && elapsed > 0 && (
                    <Text color={theme.muted}> {formatDuration(elapsed)}</Text>
                )}
                {task.status !== "running" && task.duration !== undefined && (
                    <Text color={theme.muted}> ({formatDuration(task.duration)})</Text>
                )}
            </Box>

            {/* Error message */}
            {task.status === "error" && task.error && (
                <Box paddingLeft={2}>
                    <Text color={theme.error}>{task.error}</Text>
                </Box>
            )}

            {/* Nested children with tree characters */}
            {task.children && task.children.length > 0 && (
                <Box flexDirection="column" paddingLeft={2}>
                    {task.children.map((child, i) => {
                        const isLast = i === task.children!.length - 1;
                        const prefix = isLast
                            ? `${symbols.corner}${symbols.dash}${symbols.dash} `
                            : `${symbols.branch}${symbols.dash}${symbols.dash} `;

                        return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: static list rendering
                            <Box key={i}>
                                <Text color={theme.muted}>{prefix}</Text>
                                <TaskIcon status={child.status} />
                                <Text> </Text>
                                <Text
                                    color={
                                        child.status === "error"
                                            ? theme.error
                                            : child.status === "success"
                                              ? undefined
                                              : theme.muted
                                    }
                                >
                                    {child.label}
                                </Text>
                                {child.duration !== undefined && (
                                    <Text color={theme.muted}> ({formatDuration(child.duration)})</Text>
                                )}
                                {child.status === "error" && child.error && (
                                    <Text color={theme.error}> {child.error}</Text>
                                )}
                            </Box>
                        );
                    })}
                </Box>
            )}
        </Box>
    );
}

export function TaskList({ tasks }: TaskListProps) {
    return (
        <Box flexDirection="column">
            {tasks.map((task, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static list rendering
                <TaskRow key={i} task={task} />
            ))}
        </Box>
    );
}
