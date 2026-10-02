import { SafeJSON } from "@genesiscz/utils/json";
import { stripAnsi } from "@genesiscz/utils/string";
import { parseTranscriptLine } from "./parse-line";
import { clipResult, type TranscriptTool, type TranscriptTurn } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

export function codexGtEventsToTurns(lines: readonly (string | unknown)[]): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    let assistant: TranscriptTurn | null = null;

    const flushAssistant = () => {
        if (assistant && (assistant.text || assistant.tools.length > 0)) {
            turns.push(assistant);
        }
        assistant = null;
    };

    for (const line of lines) {
        const parsed = parseTranscriptLine(line);
        if (!parsed) {
            continue;
        }
        const method = asString(parsed.method);
        const params = isRecord(parsed.params) ? parsed.params : {};
        const at = asString(parsed.ts) || null;

        if (method.includes("agentMessage")) {
            assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
            assistant.text += asString(params.delta) || asString(params.text) || asString(params.message);
            continue;
        }
        if (method.includes("userMessage") || method.includes("user/message")) {
            flushAssistant();
            const text = asString(params.text) || asString(params.message) || asString(params.body);
            if (text) {
                turns.push({ id: `codex-user-${turns.length + 1}`, role: "user", at, text, tools: [] });
            }
            continue;
        }
        if (method.includes("commandExecution") || method.includes("tool")) {
            assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
            const name = method.includes("commandExecution") ? "commandExecution" : method.split("/").at(-1) || "tool";
            assistant.tools.push({
                id: asString(params.id) || `codex-tool-${assistant.tools.length}`,
                name,
                inputPreview: asString(params.command) || asString(params.input) || "",
                result: clipResult(asString(params.output) || asString(params.result) || "") || null,
                isError: params.failed === true,
            });
        }
    }
    flushAssistant();
    return turns;
}

/**
 * Codex encrypts the text its collaboration tools pass between agents (`spawn_agent`, `send_message`,
 * `followup_task`): the `message` argument is a Fernet token, `gAAAAA` and kilobytes of base64. Shown
 * as is, one spawn filled a screen of the transcript with noise (2026-10-02).
 */
const ENCRYPTED_TOKEN = /^gAAAAA[A-Za-z0-9_=-]{40,}$/;

function withoutEncryptedValues(parsed: Record<string, unknown>): { value: Record<string, unknown>; changed: boolean } {
    let changed = false;
    const value: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(parsed)) {
        if (typeof field === "string" && ENCRYPTED_TOKEN.test(field)) {
            value[key] = `[encrypted by Codex, ${field.length} chars]`;
            changed = true;
        } else {
            value[key] = field;
        }
    }
    return { value, changed };
}

function previewFromArguments(raw: string): string {
    if (!raw) {
        return "";
    }
    const parsed = parseTranscriptLine(raw);
    if (parsed) {
        const candidate = parsed.command ?? parsed.cmd ?? parsed.path ?? parsed.file_path ?? parsed.target_file;
        if (typeof candidate === "string" && candidate) {
            return candidate;
        }

        const redacted = withoutEncryptedValues(parsed);
        if (redacted.changed) {
            return SafeJSON.stringify(redacted.value);
        }
    }
    return raw;
}

/**
 * Current Codex runs its work as `custom_tool_call` scripts named `exec` (JavaScript calling
 * `tools.exec_command(...)`, `tools.apply_patch(...)`, MCP tools), and records each command, patch and
 * MCP call it made as an `item_completed` event. The items are the actions, with their output and exit
 * code; a script that only called these tools adds nothing beside them. Reading neither left a
 * session that ran 126 commands with no tool rows at all (2026-10-02).
 */
const TOOLS_WITH_ITEMS = /^(exec_command|write_stdin|apply_patch|mcp__\w+|clock__\w+)$/;

/** Whether an `exec` script's work shows as items, so the script itself needs no row. */
function scriptShownByItems(script: string): boolean {
    const used = [...script.matchAll(/tools\.([A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1] ?? "");
    return used.length > 0 && used.every((name) => TOOLS_WITH_ITEMS.test(name));
}

/** A tool output: a string, or a list of `input_text` / `output_text` parts. */
function outputText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (!Array.isArray(value)) {
        return "";
    }

    return value
        .map((part) => (isRecord(part) ? asString(part.text) : ""))
        .filter(Boolean)
        .join("\n");
}

function shellCommand(command: unknown): string {
    if (!Array.isArray(command)) {
        return asString(command);
    }

    const parts = command.map(asString);
    // `["/bin/zsh", "-lc", "<the command>"]`: the command is what the agent wrote.
    if (parts.length === 3 && /^-l?c$/.test(parts[1] ?? "")) {
        return parts[2] ?? "";
    }

    return parts.join(" ");
}

/** A FileChange as the apply_patch text the transcript renders: one section per file. */
function patchText(changes: unknown): string {
    if (!isRecord(changes)) {
        return "";
    }

    const sections: string[] = ["*** Begin Patch"];
    for (const [file, raw] of Object.entries(changes)) {
        const change = isRecord(raw) ? raw : {};
        const kind = asString(change.type);
        if (kind === "add") {
            sections.push(
                `*** Add File: ${file}`,
                ...asString(change.content)
                    .split("\n")
                    .map((line) => `+${line}`)
            );
        } else if (kind === "delete") {
            sections.push(`*** Delete File: ${file}`);
        } else {
            sections.push(`*** Update File: ${file}`);
            const moved = asString(change.move_path);
            if (moved) {
                sections.push(`*** Move to: ${moved}`);
            }

            sections.push(asString(change.unified_diff));
        }
    }
    sections.push("*** End Patch");
    return sections.join("\n");
}

function toolResult(tool: TranscriptTool, text: string): void {
    if (text) {
        tool.result = clipResult(text);
        tool.resultChars = text.length;
    }
}

/** The tool row an `item_completed` item stands for; null for items that are not actions. */
function itemTool(item: Record<string, unknown>): TranscriptTool | null {
    const id = asString(item.id);
    const kind = asString(item.type);
    if (kind === "CommandExecution") {
        const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
        const tool: TranscriptTool = {
            id,
            name: "exec_command",
            inputPreview: shellCommand(item.command),
            result: null,
            isError: exitCode !== undefined && exitCode !== 0,
            exitCode,
        };
        // A command's colours arrive as escape codes, which the transcript printed as "[0;36m".
        toolResult(tool, stripAnsi(asString(item.aggregated_output) || asString(item.stdout) + asString(item.stderr)));
        return tool;
    }

    if (kind === "McpToolCall") {
        const result = isRecord(item.result) ? item.result : {};
        const tool: TranscriptTool = {
            id,
            name: `mcp__${asString(item.server)}__${asString(item.tool)}`,
            inputPreview: isRecord(item.arguments) ? SafeJSON.stringify(item.arguments) : asString(item.arguments),
            result: null,
            isError: result.isError === true || asString(item.status) === "failed",
        };
        toolResult(tool, outputText(result.content) || asString(item.error));
        return tool;
    }

    if (kind === "FileChange") {
        const tool: TranscriptTool = {
            id,
            name: "apply_patch",
            inputPreview: patchText(item.changes),
            result: null,
            isError: asString(item.status) === "failed",
        };
        toolResult(tool, asString(item.stdout) + asString(item.stderr));
        return tool;
    }

    return null;
}

/** The text of a `response_item` message: its `input_text` / `output_text` parts, in order. */
function contentText(content: unknown): string {
    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .filter(isRecord)
        .map((part) => asString(part.text))
        .filter((text) => text.length > 0)
        .join("\n");
}

/** A reasoning summary arrives as `summary[].text` or as `summary_text`, a string or a list. */
function reasoningText(value: unknown): string {
    if (Array.isArray(value)) {
        return value
            .map((entry) => (isRecord(entry) ? asString(entry.text) : asString(entry)))
            .filter((text) => text.length > 0)
            .join("\n");
    }

    return asString(value);
}

/**
 * Codex files its own context blocks (plugin lists, AGENTS.md, environment) as `user` messages.
 * Their metadata names what they carry; a real prompt is the one kind `user.text`, and a message
 * with no metadata at all comes from an older rollout that never injected context this way.
 */
function isTypedPrompt(payload: Record<string, unknown>): boolean {
    const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
        ? payload.internal_chat_message_metadata_passthrough
        : undefined;
    const kinds = metadata?.content_item_kinds;

    return !Array.isArray(kinds) || kinds.includes("user.text");
}

/**
 * Native rollouts record the model's messages as `response_item` items with content parts, the
 * reasoning as `response_item/reasoning` (summary usually empty, the text lives in the
 * `item_completed` event) and the per-call tokens as `token_usage_record`; the streamed
 * `event_msg` user/agent messages below them exist only in older files.
 */
export function codexNativeLinesToTurns(lines: readonly (string | unknown)[]): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    let assistant: TranscriptTurn | null = null;

    const flushAssistant = () => {
        if (assistant && (assistant.text || assistant.tools.length > 0 || assistant.usage || assistant.reasoning)) {
            turns.push(assistant);
        }
        assistant = null;
    };

    for (const line of lines) {
        const parsed = parseTranscriptLine(line);
        if (!parsed) {
            continue;
        }
        const type = asString(parsed.type);
        const payload = isRecord(parsed.payload) ? parsed.payload : {};
        const at = asString(parsed.timestamp) || null;
        const payloadType = asString(payload.type);

        if (type === "response_item" && payloadType === "message") {
            const role = asString(payload.role);
            const text = contentText(payload.content);

            if (role === "user") {
                flushAssistant();
                if (text && isTypedPrompt(payload)) {
                    turns.push({ id: `codex-user-${turns.length + 1}`, role: "user", at, text, tools: [] });
                }
            } else if (role === "assistant" && text) {
                assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
                assistant.text += assistant.text ? `\n${text}` : text;
            }
            // `developer` and `system` messages are instructions, not conversation.
            continue;
        }
        if (type === "response_item" && payloadType === "reasoning") {
            const summary = reasoningText(payload.summary);
            if (summary) {
                assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
                assistant.reasoning = assistant.reasoning ? `${assistant.reasoning}\n${summary}` : summary;
            }
            continue;
        }
        if (type === "event_msg" && payloadType === "item_completed") {
            const item = isRecord(payload.item) ? payload.item : {};
            const action = itemTool(item);
            if (action) {
                assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
                assistant.tools.push(action);
                continue;
            }

            const summary = asString(item.type) === "Reasoning" ? reasoningText(item.summary_text) : "";
            if (summary && !(assistant?.reasoning ?? "").includes(summary)) {
                assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
                assistant.reasoning = assistant.reasoning ? `${assistant.reasoning}\n${summary}` : summary;
            }
            continue;
        }
        if (type === "token_usage_record") {
            const usage = isRecord(payload.usage) ? payload.usage : {};
            const count = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
            const input = count(usage.input_tokens);
            const cached = count(usage.cached_input_tokens);
            assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
            assistant.usage = {
                // `cached_input_tokens` is a SUBSET of `input_tokens`. Verified against real
                // rollouts: `input + output === total` holds for every record with a non-zero
                // cache, while `input + cached + output` never does. The compact footer prints
                // `in X (cache Y)` as two disjoint figures, the way claude (already net of cache)
                // and grok (disjoint fields) feed it, so the cached part is taken out of `in`
                // rather than counted in both — a 273.1K/267.6K call is 5.5K of fresh input.
                inputTokens: input === undefined ? undefined : Math.max(0, input - (cached ?? 0)),
                cacheReadTokens: cached,
                outputTokens: count(usage.output_tokens),
                reasoningTokens: count(usage.reasoning_output_tokens),
            };
            continue;
        }
        if (type === "event_msg" && (payloadType === "user_message" || payloadType === "user_message_delta")) {
            flushAssistant();
            const text = asString(payload.message) || asString(payload.text);
            if (text) {
                turns.push({ id: `codex-user-${turns.length + 1}`, role: "user", at, text, tools: [] });
            }
            continue;
        }
        if (type === "event_msg" && (payloadType === "agent_message" || payloadType === "agent_message_delta")) {
            assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
            assistant.text += asString(payload.message) || asString(payload.text);
            continue;
        }
        if (type === "response_item" && payloadType === "function_call") {
            assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
            assistant.tools.push({
                id: asString(payload.call_id) || `codex-tool-${assistant.tools.length}`,
                name: asString(payload.name) || "tool",
                inputPreview: previewFromArguments(asString(payload.arguments)),
                result: null,
                isError: false,
            });
            continue;
        }
        if (type === "response_item" && payloadType === "custom_tool_call") {
            const script = asString(payload.input);
            const name = asString(payload.name) || "tool";
            if (name === "exec" && scriptShownByItems(script)) {
                continue;
            }

            assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
            assistant.tools.push({
                id: asString(payload.call_id) || `codex-tool-${assistant.tools.length}`,
                name,
                inputPreview: script,
                result: null,
                isError: false,
            });
            continue;
        }
        if (type === "response_item" && payloadType === "custom_tool_call_output" && assistant) {
            const tool = assistant.tools.find((t) => t.id === asString(payload.call_id));
            if (tool) {
                toolResult(tool, outputText(payload.output));
            }
            continue;
        }
        if (type === "response_item" && payloadType === "function_call_output" && assistant) {
            const tool = assistant.tools.find((t) => t.id === asString(payload.call_id)) ?? assistant.tools.at(-1);
            if (tool) {
                const result = asString(payload.output) || asString(payload.result);
                if (result) {
                    tool.result = clipResult(result);
                }
            }
        }
    }
    flushAssistant();
    return turns;
}
