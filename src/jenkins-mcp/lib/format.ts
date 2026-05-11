import { formatDuration } from "@app/utils/format";
import type { FlowNode, Stage, StageStatus } from "./pipeline";

export { formatDuration };

export function slugify(jobPath: string): string {
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

/** Format a stage or flow node as a one-liner with duration / running-for-X. */
export function formatStageLine(node: Stage | FlowNode, now: number = Date.now()): string {
    const icon = statusIcon(node.status);

    if (node.status === "IN_PROGRESS" && node.startTimeMillis) {
        return `${icon} ${node.name}  running for ${formatDuration(now - node.startTimeMillis)}`;
    }

    if (node.durationMillis !== undefined) {
        return `${icon} ${node.name}  ${node.status}  ${formatDuration(node.durationMillis)}`;
    }

    return `${icon} ${node.name}  ${node.status}`;
}

/** Short notification body: status icon + duration if known. */
export function stageNotifyBody(node: Stage | FlowNode): string {
    if (node.durationMillis !== undefined) {
        return `${statusBody(node.status)}  ${formatDuration(node.durationMillis)}`;
    }

    return statusBody(node.status);
}
