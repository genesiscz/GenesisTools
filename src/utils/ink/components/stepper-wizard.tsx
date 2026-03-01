/**
 * StepperWizard — Progress bar with numbered step list.
 *
 * Renders a visual progress bar and vertical step list with status indicators:
 *   [████████░░░░░░░░] 3/8
 *   ✓ 1. Pre-flight Checks (2.1s)
 *   ✓ 2. Analyze Commits (0.3s)
 *   ● 3. Version Selection...
 *   ○ 4. Changelog Preview
 *
 * Usage:
 *   <StepperWizard steps={steps} currentStep={3} totalSteps={8} />
 */

import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { formatDuration } from "../lib/format.js";
import { symbols, theme } from "../lib/theme.js";

type StepStatus = "pending" | "active" | "completed" | "error";

interface Step {
    label: string;
    status: StepStatus;
    duration?: number;
}

interface StepperWizardProps {
    steps: Step[];
    currentStep: number;
    totalSteps: number;
}

const BAR_WIDTH = 24;

function ProgressBar({ current, total }: { current: number; total: number }) {
    const filled = Math.round((current / total) * BAR_WIDTH);
    const empty = BAR_WIDTH - filled;

    return (
        <Box>
            <Text color={theme.primary}>[</Text>
            <Text color={theme.primary}>{"\u2588".repeat(filled)}</Text>
            <Text color={theme.muted}>{"\u2591".repeat(empty)}</Text>
            <Text color={theme.primary}>]</Text>
            <Text> </Text>
            <Text color={theme.muted}>
                {current}/{total}
            </Text>
        </Box>
    );
}

function StepIcon({ status }: { status: StepStatus }) {
    switch (status) {
        case "completed":
            return <Text color={theme.success}>{symbols.success}</Text>;
        case "active":
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

function StepRow({ step, index }: { step: Step; index: number }) {
    const labelColor =
        step.status === "completed"
            ? theme.success
            : step.status === "active"
              ? theme.primary
              : step.status === "error"
                ? theme.error
                : theme.muted;

    return (
        <Box>
            <StepIcon status={step.status} />
            <Text> </Text>
            <Text color={labelColor}>
                {index + 1}. {step.label}
            </Text>
            {step.status === "active" && <Text color={theme.muted}>...</Text>}
            {step.duration !== undefined && <Text color={theme.muted}> ({formatDuration(step.duration)})</Text>}
        </Box>
    );
}

export function StepperWizard({ steps, currentStep, totalSteps }: StepperWizardProps) {
    return (
        <Box flexDirection="column" gap={0}>
            <ProgressBar current={currentStep} total={totalSteps} />
            <Box flexDirection="column" marginTop={1}>
                {steps.map((step, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static list rendering
                    <StepRow key={i} step={step} index={i} />
                ))}
            </Box>
        </Box>
    );
}
