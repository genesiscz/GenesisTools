/**
 * ProgressSteps — Step list with status indicators
 *
 * Renders a vertical list of steps with status icons:
 * - completed: green checkmark + duration
 * - running: animated spinner + "..." suffix
 * - error: red cross + error message
 * - pending: gray circle
 *
 * Accepts either a `steps` prop array or React children.
 */

import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type React from "react";
import { formatDuration } from "../lib/format.js";

export type StepStatus = "pending" | "running" | "completed" | "error";

export interface StepProps {
    label: string;
    status: StepStatus;
    duration?: number;
    error?: string;
}

export interface ProgressStepsProps {
    children?: React.ReactNode;
    steps?: StepProps[];
}

// ── Step component ──────────────────────────────────────────────────────────

export function Step({ label, status, duration, error }: StepProps) {
    switch (status) {
        case "completed":
            return (
                <Box>
                    <Text color="green">{"\u2713"} </Text>
                    <Text>{label}</Text>
                    {duration !== undefined && <Text dimColor> ({formatDuration(duration)})</Text>}
                </Box>
            );

        case "running":
            return (
                <Box>
                    <Text color="blue">
                        <Spinner type="dots" />
                    </Text>
                    <Text> {label}...</Text>
                </Box>
            );

        case "error":
            return (
                <Box flexDirection="column">
                    <Box>
                        <Text color="red">{"\u2717"} </Text>
                        <Text>{label}</Text>
                    </Box>
                    {error && (
                        <Box paddingLeft={2}>
                            <Text color="red" wrap="wrap">
                                Failed: {error}
                            </Text>
                        </Box>
                    )}
                </Box>
            );

        case "pending":
            return (
                <Box>
                    <Text dimColor>{"\u25CB"} </Text>
                    <Text dimColor>{label}</Text>
                </Box>
            );
    }
}

// ── Main component ──────────────────────────────────────────────────────────

export function ProgressSteps({ steps, children }: ProgressStepsProps) {
    if (children) {
        return <Box flexDirection="column">{children}</Box>;
    }

    if (!steps || steps.length === 0) {
        return null;
    }

    return (
        <Box flexDirection="column">
            {steps.map((step, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static list rendering
                <Step key={i} {...step} />
            ))}
        </Box>
    );
}
