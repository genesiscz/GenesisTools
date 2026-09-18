import { z } from "zod";

export const compactRoles = ["user", "assistant", "tool", "system", "other"] as const;
export type CompactRole = (typeof compactRoles)[number];

export const compactDecisionKinds = ["keep_both", "keep_call_truncate_result", "drop", "keep"] as const;
export type CompactDecisionKind = (typeof compactDecisionKinds)[number];

export const compactMessageSchema = z
    .object({
        id: z.string().optional(),
        role: z.string(),
        content: z.unknown().optional(),
        name: z.string().optional(),
        tool_call_id: z.string().optional(),
        tool_use_id: z.string().optional(),
        raw: z.string().optional(),
    })
    .passthrough();

export type CompactMessage = z.infer<typeof compactMessageSchema> & {
    index: number;
    roleKind: CompactRole;
    pinned: boolean;
    bytes: number;
    toolName?: string;
};

export interface CompactDecision {
    index: number;
    kind: CompactDecisionKind;
    reason: string;
    toolName?: string;
}

export interface CompactResult {
    unchanged: boolean;
    reason?: string;
    inBytes: number;
    outBytes: number;
    reduction: number;
    messages: CompactMessage[];
    lines: string[];
    decisions: CompactDecision[];
}

export function roleKind(role: string): CompactRole {
    if (role === "user" || role === "human") {
        return "user";
    }

    if (role === "assistant" || role === "model") {
        return "assistant";
    }

    if (role === "tool" || role === "tool_result" || role === "function") {
        return "tool";
    }

    if (role === "system") {
        return "system";
    }

    return "other";
}

export function isToolResult(message: { role: string; content?: unknown }): boolean {
    if (roleKind(message.role) === "tool") {
        return true;
    }

    if (!Array.isArray(message.content)) {
        return false;
    }

    return message.content.some(
        (block) =>
            block !== null &&
            typeof block === "object" &&
            "type" in block &&
            (block.type === "tool_result" || block.type === "tool_use")
    );
}
