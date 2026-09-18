import { SafeJSON } from "@genesiscz/utils/json";
import { type CompactMessage, compactMessageSchema, isToolResult, roleKind } from "./schema";

export function parseCompactJsonl(text: string): CompactMessage[] {
    const messages: CompactMessage[] = [];
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
        if (!line.trim()) {
            continue;
        }

        try {
            const parsed = compactMessageSchema.parse(SafeJSON.parse(line));
            const role = roleKind(parsed.role);
            messages.push({
                ...parsed,
                index,
                roleKind: role,
                pinned: false,
                bytes: line.length,
                toolName: typeof parsed.name === "string" ? parsed.name : undefined,
                raw: parsed.raw ?? line,
            });
        } catch {
            messages.push({
                index,
                role: "other",
                roleKind: "other",
                pinned: false,
                bytes: line.length,
                raw: line,
            });
        }
    }
    return messages;
}

export function serializeMessage(message: CompactMessage, maxResult?: number): string {
    if (message.raw && (maxResult === undefined || !isToolResult(message))) {
        return message.raw;
    }

    if (maxResult !== undefined && isToolResult(message)) {
        const content =
            typeof message.content === "string"
                ? message.content.slice(0, maxResult)
                : SafeJSON.stringify(message.content);
        return SafeJSON.stringify({
            role: message.role,
            name: message.name,
            tool_call_id: message.tool_call_id,
            tool_use_id: message.tool_use_id,
            content: content.length > maxResult ? `${content.slice(0, maxResult)}…` : content,
        });
    }

    return message.raw ?? SafeJSON.stringify(message);
}

export function measureBytes(lines: string[]): number {
    return lines.reduce((total, line) => total + line.length + 1, 0);
}
