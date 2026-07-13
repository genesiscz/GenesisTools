import { formatDuration } from "@app/utils/format";
import type { FlowNode, Stage, StageStatus } from "./pipeline";

export { formatDuration };

export function slugifyJobPath(jobPath: string): string {
    return jobPath
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .split("/")
        .filter((s) => s && s !== "job")
        .join("-");
}

const ICONS: Record<StageStatus, string> = {
    SUCCESS: "✓",
    FAILED: "✗",
    UNSTABLE: "⚠",
    ABORTED: "⊘",
    IN_PROGRESS: "⏳",
    PAUSED_PENDING_INPUT: "⏸",
    NOT_EXECUTED: "⏸",
};

export function statusIcon(status: StageStatus): string {
    return ICONS[status] ?? "?";
}

export function statusBody(status: StageStatus | "QUEUED"): string {
    switch (status) {
        case "SUCCESS":
            return "✓ SUCCESS";
        case "FAILED":
            return "✗ FAILED";
        case "UNSTABLE":
            return "⚠ UNSTABLE";
        case "ABORTED":
            return "⊘ ABORTED";
        case "IN_PROGRESS":
            return "⏳ running";
        default:
            return status;
    }
}

function nodeDisplayName(node: Stage | FlowNode): string {
    if ("label" in node && typeof node.label === "string" && node.label) {
        return node.label;
    }

    return node.name;
}

/** Format a stage or flow node as a one-liner with duration / running-for-X. */
export function formatStageLine(node: Stage | FlowNode, now: number = Date.now()): string {
    const icon = statusIcon(node.status);
    const name = nodeDisplayName(node);

    if (node.status === "IN_PROGRESS" && node.startTimeMillis) {
        return `${icon} ${name}  running for ${formatDuration(now - node.startTimeMillis)}`;
    }

    if (node.durationMillis !== undefined) {
        return `${icon} ${name}  ${node.status}  ${formatDuration(node.durationMillis)}`;
    }

    return `${icon} ${name}  ${node.status}`;
}

/** Status icon + optional duration (no stage name). */
export function stageNotifyStatus(node: Stage | FlowNode): string {
    if (node.durationMillis !== undefined) {
        return `${statusBody(node.status)}  ${formatDuration(node.durationMillis)}`;
    }

    return statusBody(node.status);
}

/**
 * Notification body: always lead with the display label (e.g. "fee-web · SonarQube")
 * so parallel-branch context is visible even when the OS truncates/hides subtitle.
 */
export function stageNotifyBody(node: Stage | FlowNode): string {
    const label = nodeDisplayName(node);
    return `${label}  ${stageNotifyStatus(node)}`;
}
