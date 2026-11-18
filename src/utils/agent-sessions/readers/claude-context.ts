import { basename } from "node:path";
import { claudeUsageOfRow } from "@genesiscz/utils/ai/usage/spend/parse";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";
import type { ContextItem, LoopContext, SessionLoop } from "../analysis-types";
import { isoOf } from "./analysis-lines";
import { isCompactBoundary, type LoopCollector } from "./claude-analysis-loops";

const excluded = new Set([
    "hook_success",
    "hook_system_message",
    "hook_non_blocking_error",
    "hook_cancelled",
    "prompt_snapshot",
    "deferred_tools_record",
]);
const injectionNames: [RegExp, string][] = [
    [/area rules were not in your context/, "area-rules"],
    [/^The following rules are in force/, "weak-model-inject"],
    [/^<persisted-output>/, "persisted-output"],
    [/Shell hygiene/, "shell-hygiene"],
    [/agents-talk/, "agents-talk-hint"],
    [/^INBOX:/, "inbox-hint"],
    [/Session ID:/, "session-files"],
    [/^rm request/, "rm-request"],
    [/You have pstack/, "pstack-mandate"],
    [/\[session-name\]/, "session-name"],
    [/^\[genesis-tools-mods:/, "mods-dedupe-receipt"],
];

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function injectionName(body: string): string {
    const head = body.trimStart().slice(0, 400);
    return injectionNames.find(([pattern]) => pattern.test(head))?.[1] ?? head.slice(0, 40).replace(/\s+/g, " ");
}

type Add = (source: string, key: string, chars: number, imageTokens?: number) => void;

function addParts(source: string, key: string, content: unknown, add: Add): void {
    let chars = 0;
    let images = 0;
    for (const part of Array.isArray(content) ? content : [content]) {
        if (isObject(part) && part.type === "image") {
            images++;
        } else {
            chars += text(isObject(part) ? part.text : part).length;
        }
    }
    add(source, key, chars);
    if (images) {
        add(source, `${key} (images)`, 0, 2_000 * images);
    }
}

function addHook(attachment: Record<string, unknown>, add: Add): void {
    const event = text(attachment.hookEvent) || text(attachment.hookName) || "?";
    for (const part of Array.isArray(attachment.content) ? attachment.content : [attachment.content]) {
        const body = text(part);
        const blocks = [...body.matchAll(/Contents of ([^\n]+?) \(area rules\):/g)];
        if (blocks.length) {
            for (const [i, block] of blocks.entries()) {
                const end = blocks[i + 1]?.index ?? body.length;
                add("hook", `area-rules:${basename(block[1])} (${event})`, end - (i === 0 ? 0 : block.index));
            }
        } else {
            const key = event === "PostToolUseFailure" ? "tool failure text" : injectionName(body);
            add("hook", `${key} (${event})`, body.length);
        }
    }
}

function shortPath(value: unknown): string {
    return text(value).replace(/^\/Users\/[^/]+\//, "~/");
}

function addAttachment(row: Record<string, unknown>, add: Add): void {
    const attachment = row.attachment;
    if (!isObject(attachment)) {
        return;
    }
    const type = text(attachment.type) || "?";
    if (excluded.has(type)) {
        return;
    }
    if (type === "hook_additional_context") {
        addHook(attachment, add);
    } else if (type === "instructions" && Array.isArray(attachment.files)) {
        for (const file of attachment.files) {
            if (isObject(file)) {
                add("instructions", shortPath(file.path), text(file.content).length);
            }
        }
    } else if (type === "nested_memory") {
        const body = isObject(attachment.content) ? attachment.content.content : attachment.content;
        add("rule-file", text(attachment.displayPath) || shortPath(attachment.path), text(body).length);
    } else if (type === "queued_command") {
        const origin = isObject(attachment.origin) ? text(attachment.origin.kind) : "";
        addParts("queued", origin || text(attachment.commandMode) || "?", attachment.prompt, add);
    } else {
        const rendered = Array.isArray(row.rendered)
            ? row.rendered
                  .filter(isObject)
                  .map((part) => text(part.content))
                  .join("")
            : "";
        const content = rendered || text(attachment.content) || SafeJSON.stringify(attachment, { strict: true });
        const blocking = type === "hook_blocking_error";
        add(blocking ? "hook-block" : type, blocking ? text(attachment.hookName) || "?" : type, content.length);
    }
}

function addUser(row: Record<string, unknown>, first: boolean, tools: Map<string, string>, add: Add): void {
    const content = isObject(row.message) ? row.message.content : null;
    for (const part of Array.isArray(content) ? content : [content]) {
        if (isObject(part) && part.type === "tool_result") {
            addParts("tool_result", tools.get(text(part.tool_use_id)) ?? "?", part.content, add);
            continue;
        }
        if (isObject(part) && part.type === "image") {
            add("prompt", "image", 0, 2_000);
            continue;
        }
        const body = text(isObject(part) ? part.text : part);
        if (row.isCompactSummary === true) {
            add("compact-summary", "summary", body.length);
        } else if (body.startsWith("Base directory for this skill")) {
            add("skill-body", basename(body.split("\n", 1)[0].trim()), body.length);
        } else if (body.includes("<task-notification>")) {
            add("task-notification", "task-notification", body.length);
        } else if (first && row.isSidechain === true) {
            add("agent-prompt", "brief from the parent", body.length);
        } else if (row.isMeta === true || body.trimStart().startsWith("<system-reminder>")) {
            add("harness-text", injectionName(body.replace(/^\s*<system-reminder>\s*/, "")), body.length);
        } else {
            add("prompt", "human or queued prompt", body.length);
        }
    }
}

export function collectContext(loop: SessionLoop): LoopCollector<LoopContext> {
    const items: ContextItem[] = [];
    const models = new Map<string, number>();
    const toolNames = new Map<string, string>();
    const toolCalls = new Map<string, number>();
    const seen = new Set<string>();
    const boundaries = new Set<string>();
    let compactions = 0;
    let segmentStart = 0;
    let visibleTokens = 0;
    let firstCallContext: number | null = null;
    let peakContext: number | null = null;
    let cacheRead = 0;
    let firstUser = true;
    let baseline: ContextItem | undefined;

    // While a segment is open carryCalls holds the call count at entry. Close each item once.
    function closeSegment(): void {
        for (let i = segmentStart; i < items.length; i++) {
            items[i].carryCalls = seen.size - items[i].carryCalls;
        }
        segmentStart = items.length;
        visibleTokens = 0;
    }

    return {
        visit({ row, path, line }) {
            const at = isoOf(row.timestamp);
            const add: Add = (source, key, chars, imageTokens) => {
                const tokens = imageTokens ?? Math.round(chars / 4);
                if (tokens > 0) {
                    items.push({ path, line, at, source, key, tokens, carryCalls: seen.size });
                    visibleTokens += tokens;
                }
            };
            if (row.type === "attachment") {
                addAttachment(row, add);
            } else if (row.type === "user") {
                addUser(row, firstUser, toolNames, add);
                firstUser = false;
            } else if (isCompactBoundary(row)) {
                const id = text(row.uuid);
                if (!id || !boundaries.has(id)) {
                    boundaries.add(id);
                    compactions++;
                    closeSegment();
                }
            } else if (row.type === "assistant" && isObject(row.message) && row.message.model !== "<synthetic>") {
                const usage = claudeUsageOfRow(row);
                if (usage && !seen.has(usage.messageId)) {
                    const context = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
                    if (firstCallContext === null) {
                        firstCallContext = context;
                        if (context > visibleTokens) {
                            baseline = {
                                path,
                                at,
                                line: 0,
                                source: "system-prompt+tools",
                                key: "measured first call minus counted rows",
                                tokens: context - visibleTokens,
                                carryCalls: 0,
                            };
                        }
                    }
                    peakContext = Math.max(peakContext ?? 0, context);
                    seen.add(usage.messageId);
                    cacheRead += usage.cacheReadTokens;
                    models.set(usage.model, (models.get(usage.model) ?? 0) + 1);
                }
                for (const part of Array.isArray(row.message.content) ? row.message.content : []) {
                    if (!isObject(part)) {
                        continue;
                    }
                    if (part.type === "text") {
                        add("assistant", "text", text(part.text).length);
                    } else if (part.type === "thinking") {
                        add("assistant", "thinking (stored text, may be a summary)", text(part.thinking).length);
                    } else if (part.type === "tool_use") {
                        const name = text(part.name) || "?";
                        toolNames.set(text(part.id), name);
                        toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
                        add(
                            "assistant",
                            `tool input: ${name}`,
                            SafeJSON.stringify(part.input ?? {}, { strict: true }).length
                        );
                    }
                }
            }
        },
        finish() {
            closeSegment();
            if (baseline) {
                baseline.carryCalls = Math.max(0, seen.size - 1);
                items.unshift(baseline);
            }
            return {
                ...loop,
                calls: seen.size,
                model: [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
                firstCallContext,
                peakContext,
                cacheRead,
                toolCalls: Object.fromEntries(toolCalls),
                compactions,
                items,
            };
        },
    };
}
