import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";
import { nonEmptyString as text } from "@genesiscz/utils/string";
import type { NativeSourceIssue, NativeToolCall, ToolCallsRead } from "../types";
import { readToolCallLines } from "./tool-calls";

/**
 * Only lines holding the literal `"type":"tool_use"` are parsed. Inside a tool RESULT that text is JSON-escaped
 * (`\"type\":\"tool_use\"`), so a transcript quoting itself cannot match.
 */
const TOOL_USE_MARKER = '"type":"tool_use"';

function field(value: unknown, key: string): unknown {
    return isObject(value) ? value[key] : undefined;
}

/** One Claude row's `tool_use` blocks, with the row's `cwd` and its `timestamp` as the call's time. */
function claudeToolCallLine(path: string, line: string, into: NativeToolCall[], issues: NativeSourceIssue[]): void {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(line, { strict: true });
    } catch (err) {
        issues.push({
            path,
            message: `skipped a transcript line that is not JSON (${line.length} bytes): ${String(err)}`,
        });
        return;
    }

    const cwd = text(field(parsed, "cwd"));
    const content = field(field(parsed, "message"), "content");

    if (!cwd || !Array.isArray(content)) {
        return;
    }

    const stamp = Date.parse(text(field(parsed, "timestamp")) ?? "");
    const at = Number.isFinite(stamp) ? { at: stamp } : {};

    for (const block of content) {
        const name = text(field(block, "name"));

        if (field(block, "type") === "tool_use" && name) {
            into.push({ tool: name, input: field(block, "input"), cwd, ...at });
        }
    }
}

/** Claude's `readToolCalls`: every `tool_use` block a session JSONL gained since `fromOffset`, timed by its row. */
export function claudeToolCalls(transcriptPath: string, fromOffset: number): ToolCallsRead {
    return readToolCallLines({
        path: transcriptPath,
        from: fromOffset,
        markers: [TOOL_USE_MARKER],
        parse: (line, into, issues) => claudeToolCallLine(transcriptPath, line, into, issues),
    });
}
