import { SafeJSON } from "@genesiscz/utils/json";

export const COMPACT_SOURCES = ["jsonl", "claude", "codex", "grok"] as const;
export type CompactSource = (typeof COMPACT_SOURCES)[number];

export function parseCompactSource(value: unknown): CompactSource {
    if (typeof value === "string" && (COMPACT_SOURCES as readonly string[]).includes(value)) {
        return value as CompactSource;
    }

    throw new Error(`Unknown compact source '${String(value)}'. Valid: ${COMPACT_SOURCES.join("|")}`);
}

export function convertSessionJsonl(text: string): string {
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }

        try {
            const parsed = SafeJSON.parse(line);
            if (parsed === null || typeof parsed !== "object") {
                lines.push(line);
                continue;
            }

            const row = parsed as Record<string, unknown>;
            if (typeof row.role === "string") {
                lines.push(line);
                continue;
            }

            const message =
                row.message !== null && typeof row.message === "object"
                    ? (row.message as Record<string, unknown>)
                    : undefined;
            const role =
                typeof message?.role === "string" ? message.role : typeof row.type === "string" ? row.type : "other";
            lines.push(
                SafeJSON.stringify({
                    role,
                    content: message?.content ?? row.content,
                    name: row.name,
                    tool_call_id: row.tool_call_id ?? row.tool_use_id,
                    tool_use_id: row.tool_use_id,
                })
            );
        } catch {
            lines.push(line);
        }
    }

    return lines.join("\n");
}

export function loadCompactText(options: { source: CompactSource; text: string }): string {
    if (options.source === "jsonl") {
        return options.text;
    }

    return convertSessionJsonl(options.text);
}
