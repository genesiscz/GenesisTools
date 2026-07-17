import { SafeJSON } from "@app/utils/json";
import type { AskMessageRecord } from "@app/youtube/lib/types";

/** Human-readable summary of a dynamic collection's stored rule JSON. */
export function ruleSummary(ruleJson: string | null): string {
    if (!ruleJson) {
        return "Dynamic collection";
    }

    const rule = SafeJSON.parse(ruleJson) as { type?: string; sinceDays?: number } | null;

    if (rule?.type === "watched" && typeof rule.sinceDays === "number") {
        return `Videos you watched in the last ${rule.sinceDays} days`;
    }

    return "Dynamic collection";
}

/** Synthetic user message shown optimistically while a collection ask is in flight. */
export function optimisticUserMessage(threadId: number | null, content: string): AskMessageRecord {
    return {
        id: -1,
        threadId: threadId ?? -1,
        role: "user",
        content,
        toolName: null,
        toolArgsJson: null,
        createdAt: new Date().toISOString(),
    };
}
