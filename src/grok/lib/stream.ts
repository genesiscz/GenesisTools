import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "grok:stream" });

export interface GrokToolCall {
    tool: string;
    target: string;
}

export interface GrokTurnSummary {
    report: string;
    toolCalls: GrokToolCall[];
    ended: boolean;
    malformedLines: number;
}

interface GrokStreamEvent {
    type?: string;
    data?: string;
    toolName?: string;
    rawInput?: Record<string, unknown>;
}

function toolTarget(rawInput: Record<string, unknown> | undefined): string {
    const candidate = rawInput?.command ?? rawInput?.target_file ?? rawInput?.file_path ?? "";
    return typeof candidate === "string" ? candidate : SafeJSON.stringify(candidate);
}

/**
 * The grok CLI's `--output-format streaming-json` stream is flat NDJSON
 * ({"type":"text","data":...}), not the ACP-nested shape its help implies.
 */
export function parseTurnLog(text: string): GrokTurnSummary {
    const summary: GrokTurnSummary = { report: "", toolCalls: [], ended: false, malformedLines: 0 };

    for (const line of text.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        let event: GrokStreamEvent;
        try {
            event = SafeJSON.parse(line, { strict: true }) as GrokStreamEvent;
        } catch (err) {
            summary.malformedLines += 1;
            log.debug({ err, line: line.slice(0, 200) }, "skipping malformed grok stream line");
            continue;
        }

        if (event.type === "text" && typeof event.data === "string") {
            summary.report += event.data;
        } else if (event.type === "tool_call") {
            summary.toolCalls.push({ tool: event.toolName ?? "?", target: toolTarget(event.rawInput) });
        } else if (event.type === "end") {
            summary.ended = true;
        }
    }

    return summary;
}
