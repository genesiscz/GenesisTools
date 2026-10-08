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

/** An item is a finished action: no output is an empty result, never a call still waiting. */
function toolResult(tool: TranscriptTool, text: string): void {
    tool.result = text ? clipResult(text) : "";
    if (text) {
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
 *
 * One assistant turn is one model call: reasoning, a message, the tool calls it made. A prompt that
 * ran 79 tools used to be one turn with all its text on top and every tool below, so the outputs read
 * out of order, and the live tail replaced that whole row on each change (2026-10-02). A command
 * finishes after its script returned when it runs long; it goes back under the script that ran it.
 */
export function codexNativeLinesToTurns(lines: readonly (string | unknown)[]): TranscriptTurn[] {
    const parser = createCodexTurnParser();
    parser.push(lines);
    return parser.snapshot();
}

/**
 * The native rollout parser with its state kept between calls: `push` takes the next lines, `snapshot` returns the
 * turns a full parse of every line pushed so far returns, and changes nothing, so more lines can follow. A live
 * transcript then parses only its new lines (turn-fold-cache.ts) instead of the whole file on every write.
 */
export interface CodexTurnParser {
    push(lines: readonly (string | unknown)[]): void;
    snapshot(): TranscriptTurn[];
}

export function createCodexTurnParser(): CodexTurnParser {
    const turns: TranscriptTurn[] = [];
    let assistant: TranscriptTurn | null = null;
    /** Every tool by call id: an output can arrive after the next model call began. */
    const byCallId = new Map<string, TranscriptTool>();
    /** `exec` scripts whose work shows as items, with the items matched to each, in order. */
    const scripts: ExecScript[] = [];
    const scriptByTool = new Map<TranscriptTool, ExecScript>();

    const flushAssistant = () => {
        if (assistant && (assistant.text || assistant.tools.length > 0 || assistant.usage || assistant.reasoning)) {
            turns.push(assistant);
        }
        assistant = null;
    };
    const open = (at: string | null): TranscriptTurn => {
        assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
        return assistant;
    };
    /** Reasoning or a message after tool calls is the next model call. */
    const nextCall = () => {
        if (assistant && assistant.tools.length > 0) {
            flushAssistant();
        }
    };
    const reasoningSoFar = (): string => assistant?.reasoning ?? "";
    const addTool = (tool: TranscriptTool, at: string | null) => {
        open(at).tools.push(tool);
        byCallId.set(tool.id, tool);
    };
    /**
     * The script an action ran in. Codex stamps each item with the time it started, and the script
     * running then ran it, also when the action finished after the script returned. Without the stamp,
     * only a script that still runs or belongs to this model call qualifies. A script that finished in
     * an earlier call never takes a later call's action because its text names the same command.
     */
    const ownerOf = (item: Record<string, unknown>, startedAt: unknown): ExecScript | undefined => {
        const recent = scripts.slice(-40);
        const candidates =
            typeof startedAt === "number"
                ? recent.filter((entry) => entry.startMs <= startedAt && startedAt <= entry.endMs)
                : recent.filter((entry) => entry.tool.result === null || assistant?.tools.includes(entry.tool));
        return scriptOf(candidates, item) ?? candidates.at(-1);
    };

    const push = (lines: readonly (string | unknown)[]): void => {
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
                    nextCall();
                    const turn = open(at);
                    turn.text += turn.text ? `\n${text}` : text;
                }
                // `developer` and `system` messages are instructions, not conversation.
                continue;
            }
            if (type === "response_item" && payloadType === "reasoning") {
                nextCall();
                const summary = reasoningText(payload.summary);
                if (summary && !reasoningSoFar().includes(summary)) {
                    const turn = open(at);
                    turn.reasoning = turn.reasoning ? `${turn.reasoning}\n${summary}` : summary;
                }
                continue;
            }
            if (type === "event_msg" && payloadType === "item_completed") {
                const item = isRecord(payload.item) ? payload.item : {};
                const action = itemTool(item);
                if (action) {
                    const owner = ownerOf(item, payload.started_at_ms);
                    if (owner) {
                        owner.items.push(action);
                    } else {
                        addTool(action, at);
                    }
                    continue;
                }

                if (asString(item.type) === "Reasoning") {
                    nextCall();
                }

                const summary = asString(item.type) === "Reasoning" ? reasoningText(item.summary_text) : "";
                if (summary && !reasoningSoFar().includes(summary)) {
                    const turn = open(at);
                    turn.reasoning = turn.reasoning ? `${turn.reasoning}\n${summary}` : summary;
                }
                continue;
            }
            if (type === "token_usage_record") {
                const usage = isRecord(payload.usage) ? payload.usage : {};
                const count = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
                const input = count(usage.input_tokens);
                const cached = count(usage.cached_input_tokens);
                open(at).usage = {
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
                open(at).text += asString(payload.message) || asString(payload.text);
                continue;
            }
            if (type === "response_item" && payloadType === "function_call") {
                addTool(
                    {
                        id: asString(payload.call_id) || `codex-tool-${byCallId.size}`,
                        name: asString(payload.name) || "tool",
                        inputPreview: previewFromArguments(asString(payload.arguments)),
                        result: null,
                        isError: false,
                    },
                    at
                );
                continue;
            }
            if (type === "response_item" && payloadType === "custom_tool_call") {
                const script = asString(payload.input);
                const tool: TranscriptTool = {
                    id: asString(payload.call_id) || `codex-tool-${byCallId.size}`,
                    name: asString(payload.name) || "tool",
                    inputPreview: script,
                    result: null,
                    isError: false,
                };
                addTool(tool, at);
                if (tool.name === "exec" && scriptShownByItems(script)) {
                    const entry: ExecScript = {
                        tool,
                        script,
                        items: [],
                        startMs: Date.parse(at ?? ""),
                        endMs: Infinity,
                    };
                    scripts.push(entry);
                    scriptByTool.set(tool, entry);
                }
                continue;
            }
            if (
                type === "response_item" &&
                (payloadType === "custom_tool_call_output" || payloadType === "function_call_output")
            ) {
                const tool = byCallId.get(asString(payload.call_id));
                if (tool) {
                    // An empty output is still an answer (`send_message` returns none): null would read
                    // as a call still waiting, and the hub flagged the session stuck.
                    const text = outputText(payload.output) || asString(payload.result);
                    tool.result = text ? clipResult(text) : "";
                    if (text) {
                        tool.resultChars = text.length;
                    }

                    const entry = scriptByTool.get(tool);
                    if (entry && at) {
                        entry.endMs = Date.parse(at);
                    }
                }
            }
        }
    };

    /**
     * The turns as a full parse of the lines pushed so far returns them. The parser's state stays as it is: turns
     * and tools are copies, and the open assistant turn is included rather than flushed.
     */
    const snapshot = (): TranscriptTurn[] => {
        const all = [...turns];
        if (assistant && (assistant.text || assistant.tools.length > 0 || assistant.usage || assistant.reasoning)) {
            all.push(assistant);
        }

        // A script whose work arrived as items shows those items in its place. One that has none: still
        // running, it shows itself; finished (it only polled a running command), it shows nothing.
        const replaced = new Map(scripts.map((entry) => [entry.tool, entry]));
        const shown = (tool: TranscriptTool): TranscriptTool[] => {
            const entry = replaced.get(tool);
            if (!entry) {
                return [{ ...tool }];
            }

            if (entry.items.length > 0) {
                return entry.items.map((item) => ({ ...item }));
            }

            // No items: a script that completed only polled a running command (its items arrive
            // under the script that started it), so it shows nothing. One still running, or one
            // that failed before dispatching anything ("Script failed", a bare error), shows its own
            // row, the only one carrying that text. Measured over 2026-10's rollouts: 7351 outputs
            // start "Script completed", 19 "Script failed", 1 "Script running".
            const completed = tool.result === "" || tool.result?.startsWith("Script completed") === true;
            return completed ? [] : [{ ...tool }];
        };

        return all
            .map((turn) => ({ ...turn, tools: turn.tools.flatMap(shown) }))
            .filter(
                (turn) =>
                    turn.role !== "assistant" || turn.text || turn.tools.length > 0 || turn.usage || turn.reasoning
            );
    };

    return { push, snapshot };
}

/** An `exec` script whose work shows as items, and when it ran (`endMs` is Infinity until it returns). */
interface ExecScript {
    tool: TranscriptTool;
    script: string;
    items: TranscriptTool[];
    startMs: number;
    endMs: number;
}

/**
 * Of the given scripts, the latest one whose source names the item's command, patched file or MCP
 * tool. An item no script names is the caller's to place.
 */
function scriptOf(scripts: ExecScript[], item: Record<string, unknown>): ExecScript | undefined {
    const kind = asString(item.type);
    const needles: string[] = [];
    if (kind === "CommandExecution") {
        const command = shellCommand(item.command);
        needles.push(SafeJSON.stringify(command).slice(1, -1).slice(0, 120), command.slice(0, 120));
    } else if (kind === "FileChange" && isRecord(item.changes)) {
        needles.push(...Object.keys(item.changes));
    } else if (kind === "McpToolCall") {
        needles.push(`mcp__${asString(item.server)}__${asString(item.tool)}`);
    }

    for (let index = scripts.length - 1; index >= 0 && index >= scripts.length - 40; index--) {
        const entry = scripts[index];
        if (entry && needles.some((needle) => needle && entry.script.includes(needle))) {
            return entry;
        }
    }

    return undefined;
}
