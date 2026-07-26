/**
 * Deterministic Claude Code JSONL transcript parsing + condensation.
 *
 * TypeScript port of SkillOpt's fable_clone/transcript.py (SkillOpt repo,
 * scripts committed locally in _Playgrounds/SkillOpt). No model calls here:
 * extractor models only pick WHICH turns are decision points; assembling the
 * prefix/reference from turns happens in this module so nothing is hallucinated
 * or truncated by a model. Replaces the old jq pre-filter + "adapt jq once"
 * repair stage of the /learn-from-fable command.
 */
import type { ContentBlock, ConversationMessage, ToolUseBlock } from "@genesiscz/utils/claude";
import { parseJsonlTranscript } from "@genesiscz/utils/claude";
import { SafeJSON } from "@genesiscz/utils/json";
import { FABLE_MODEL } from "./config";

export interface TurnToolCall {
    name: string;
    input: unknown;
}

export interface Turn {
    idx: number;
    role: "user" | "assistant" | "tool_result";
    text: string;
    thinking: string;
    tools: TurnToolCall[];
    resultGist: string;
    isFable: boolean;
    isSidechain: boolean;
}

/** Lines whose presence in a tool result is decisive evidence worth keeping. */
const KEY_LINE =
    /(exit\s*code|error|Error|ERROR|fail|Fail|FAIL|\b[0-9a-f]{7,40}\b|passed|PASS|✓|✗|Traceback|exception|not found|404|500|denied)/;

function trunc(value: string, max: number): string {
    const s = (value ?? "").trim();
    if (s.length <= max) {
        return s;
    }

    return `${s.slice(0, max).trimEnd()} …[+${s.length - max} chars]`;
}

/** Keep head + decisive lines (exit codes, errors, SHAs) + tail, drop bulk. */
function resultGist(text: string, cap = 600): string {
    const value = (text ?? "").trim();
    if (value.length <= cap) {
        return value;
    }

    const lines = value.split("\n");
    const head = lines.slice(0, 6);
    const key = lines
        .slice(6)
        .filter((ln) => KEY_LINE.test(ln))
        .slice(0, 8);
    const tail = lines.slice(-2);
    const out = [...head, ...(key.length || tail.length ? ["…"] : []), ...key, ...tail].join("\n");
    return trunc(out, cap * 2);
}

function blocksText(content: string | ContentBlock[] | undefined, want: "text" | "thinking"): string {
    if (typeof content === "string") {
        return want === "text" ? content : "";
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((b) => {
            if (b.type === "text" && want === "text") {
                return b.text ?? "";
            }

            if (b.type === "thinking" && want === "thinking") {
                return b.thinking ?? "";
            }

            return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
}

function toolUses(content: string | ContentBlock[] | undefined): TurnToolCall[] {
    if (!Array.isArray(content)) {
        return [];
    }

    return content
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ name: b.name, input: b.input }));
}

function isToolResult(content: string | ContentBlock[] | undefined): boolean {
    return Array.isArray(content) && content.some((b) => b.type === "tool_result");
}

function toolResultGist(content: ContentBlock[]): string {
    const outs: string[] = [];
    for (const b of content) {
        if (b.type !== "tool_result") {
            continue;
        }

        const inner = b.content;
        // Object-shaped tool_result content shows up in real transcripts;
        // String() would put "[object Object]" into the episode reference.
        const text = Array.isArray(inner)
            ? inner.map((x) => (x.type === "text" ? (x.text ?? "") : "")).join("\n")
            : typeof inner === "object" && inner !== null
              ? SafeJSON.stringify(inner, { strict: true })
              : String(inner ?? "");
        const gist = resultGist(text);
        if (gist) {
            outs.push(gist);
        }
    }

    return outs.join("\n").trim();
}

function userText(content: string | ContentBlock[] | undefined): string {
    if (typeof content === "string") {
        return content.trim();
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((b) => {
            if (b.type === "text") {
                return b.text ?? "";
            }

            if (b.type === "image") {
                return "[Image]";
            }

            return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
}

/**
 * Parse one transcript into ordered turns. Claude Code logs ONE logical
 * assistant turn as several JSONL lines (one block each) sharing message.id —
 * and that id can span across interleaved tool_results (parallel tool calls),
 * so assistant lines merge by id globally.
 */
export interface LoadTurnsOptions {
    fableModel?: string;
    /**
     * Skip lines whose uuid was already seen (first occurrence wins). Real
     * phenomenon: 18/324 corpus files carry duplicated message lines around
     * compaction/resume (worst observed: 538 dup lines in one session, measured
     * 2026-07-24). Disable only for parity testing against parsers without dedupe.
     */
    dedupeUuids?: boolean;
}

export async function loadTurns(path: string, options: LoadTurnsOptions = {}): Promise<Turn[]> {
    const fableModel = options.fableModel ?? FABLE_MODEL;
    const turns: Turn[] = [];
    const byMid = new Map<string, Turn>();
    const messages = await parseJsonlTranscript<ConversationMessage>(path, {
        dedupeUuids: options.dedupeUuids ?? true,
    });

    for (const msg of messages) {
        if (msg.type === "assistant") {
            const content = msg.message?.content;
            const text = blocksText(content, "text");
            const thinking = blocksText(content, "thinking");
            const tools = toolUses(content);
            const isFable = msg.message?.model === fableModel;
            const mid = msg.message?.id;
            const prev = mid ? byMid.get(mid) : undefined;

            if (prev) {
                if (thinking) {
                    prev.thinking = `${prev.thinking}\n${thinking}`.trim();
                }

                if (text) {
                    prev.text = `${prev.text}\n${text}`.trim();
                }

                prev.tools.push(...tools);
                prev.isFable = prev.isFable || isFable;
            } else {
                const turn: Turn = {
                    idx: turns.length,
                    role: "assistant",
                    text,
                    thinking,
                    tools,
                    resultGist: "",
                    isFable,
                    isSidechain: msg.isSidechain === true,
                };
                turns.push(turn);
                if (mid) {
                    byMid.set(mid, turn);
                }
            }
        } else if (msg.type === "user") {
            const content = msg.message?.content;
            if (isToolResult(content)) {
                turns.push({
                    idx: turns.length,
                    role: "tool_result",
                    text: "",
                    thinking: "",
                    tools: [],
                    resultGist: toolResultGist(content as ContentBlock[]),
                    isFable: false,
                    isSidechain: msg.isSidechain === true,
                });
            } else {
                const text = userText(content);
                if (text && !isSlashCommandNoise(msg, text)) {
                    turns.push({
                        idx: turns.length,
                        role: "user",
                        text,
                        thinking: "",
                        tools: [],
                        resultGist: "",
                        isFable: false,
                        isSidechain: msg.isSidechain === true,
                    });
                }
            }
        }
        // else: metadata line types (summary, system, file-history-snapshot, progress…) — skipped
    }

    return turns;
}

/**
 * Slash-command scaffolding the CLI injects as user messages (`/model`, its
 * caveat banner, its stdout). It is not something the agent responded to, so it
 * must not enter an episode's context prefix.
 */
const SLASH_COMMAND_WRAPPERS = /^\s*<(local-command-caveat|command-name|command-message|local-command-stdout)>/;

function isSlashCommandNoise(msg: ConversationMessage, text: string): boolean {
    const isMeta = msg.type === "user" && msg.isMeta === true;
    return isMeta || SLASH_COMMAND_WRAPPERS.test(text);
}

function toolLine(turn: Turn, cap = 200): string {
    return turn.tools
        .map(
            (c) =>
                `${c.name}(${trunc(c.input === undefined ? "" : SafeJSON.stringify(c.input, { strict: true }), cap)})`
        )
        .join("; ");
}

/** One compact ACTION/RESULT/USER line per turn — prefix rendering, NO thinking (must not leak reasoning). */
export function actionResultLine(turn: Turn): string {
    if (turn.role === "user") {
        return `[USER] ${trunc(turn.text, 500)}`;
    }

    if (turn.role === "tool_result") {
        return `[RESULT] ${trunc(turn.resultGist, 500)}`;
    }

    const bits: string[] = [];
    if (turn.tools.length) {
        bits.push(`[ACTION] ${toolLine(turn)}`);
    }

    if (turn.text) {
        bits.push(`[SAYS] ${trunc(turn.text, 300)}`);
    }

    return bits.join("\n") || "[ACTION] (none)";
}

/** Fable's actual next move: thinking gist + tool calls + visible text. */
export function referenceGist(turn: Turn, cap = 600): string {
    const parts: string[] = [];
    if (turn.thinking) {
        parts.push(`THINKING: ${trunc(turn.thinking, cap * 3)}`);
    }

    if (turn.tools.length) {
        parts.push(`ACTION: ${toolLine(turn, 500)}`);
    }

    if (turn.text) {
        parts.push(`SAYS: ${trunc(turn.text, 600)}`);
    }

    return parts.join("\n").trim();
}

/**
 * Numbered compact windows for the extractor model. Assistant thinking IS shown
 * here (the extractor needs it to spot decision points) but is never placed in
 * an episode prefix.
 */
export function condenseForExtraction(turns: Turn[], maxChars = 36_000): string[] {
    const lines = turns.map((t) => {
        const head = `#${t.idx} ${t.role.toUpperCase()}`;

        if (t.role === "assistant") {
            const body: string[] = [];
            if (t.thinking) {
                // recall-critical: thinking is the extractor's core signal, keep near-full
                body.push(`think: ${trunc(t.thinking, 2500)}`);
            }

            if (t.tools.length) {
                body.push(`do: ${toolLine(t)}`);
            }

            if (t.text) {
                body.push(`say: ${trunc(t.text, 500)}`);
            }

            const tag = t.isFable ? " (fable)" : " (other-model)";
            return `${head}${tag}\n  ${body.join("\n  ")}`;
        }

        if (t.role === "user") {
            return `${head}\n  ${trunc(t.text, 500)}`;
        }

        return `${head}\n  result: ${trunc(t.resultGist, 400)}`;
    });

    const windows: string[] = [];
    let cur: string[] = [];
    let size = 0;
    for (const ln of lines) {
        if (size + ln.length > maxChars && cur.length) {
            windows.push(cur.join("\n"));
            cur = [];
            size = 0;
        }

        cur.push(ln);
        size += ln.length + 1;
    }

    if (cur.length) {
        windows.push(cur.join("\n"));
    }

    return windows;
}

export const TARGET_PROMPT =
    "\n\n--- You are the agent at this point. What do you do next?\n" +
    "Reply with:\nREASONING: <why, 2-6 sentences>\n" +
    "NEXT ACTION: <the exact command(s)/tool call(s) you would run, or the exact " +
    "message you would send to the user>";

/**
 * Episode prefix = the situation up to (not including) turn idx. Actions and
 * results only — no thinking. Fidelity gradient: keep EVERY user turn (task +
 * steering, always load-bearing) + the most recent trajectory that fits; gaps
 * are marked with '…'.
 */
export function buildPrefix(turns: Turn[], idx: number, maxChars = 22_000): string {
    const prior = turns.slice(0, idx);
    const lines = prior.map(actionResultLine);
    const total = lines.reduce((n, x) => n + x.length + 1, 0);
    if (total <= maxChars) {
        return lines.join("\n") + TARGET_PROMPT;
    }

    const keep = new Set<number>();
    let size = 0;
    prior.forEach((t, i) => {
        if (t.role === "user") {
            keep.add(i);
            size += lines[i].length + 1;
        }
    });

    for (let i = prior.length - 1; i >= 0; i--) {
        if (keep.has(i)) {
            continue;
        }

        if (size + lines[i].length + 1 > maxChars) {
            break;
        }

        keep.add(i);
        size += lines[i].length + 1;
    }

    const out: string[] = [];
    let prev: number | undefined;
    for (const i of [...keep].sort((a, b) => a - b)) {
        if (prev !== undefined && i > prev + 1) {
            out.push("…");
        }

        out.push(lines[i]);
        prev = i;
    }

    return out.join("\n") + TARGET_PROMPT;
}

/** Condensed tool results that immediately follow the reference turn (until the next assistant turn). */
export function referenceOutcome(turns: Turn[], idx: number, cap = 600): string {
    const outs: string[] = [];
    for (const t of turns.slice(idx + 1)) {
        if (t.role === "assistant") {
            break;
        }

        if (t.role === "tool_result" && t.resultGist) {
            outs.push(t.resultGist);
        }
    }

    return outs.join("\n").slice(0, cap);
}
