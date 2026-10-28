import { createHash } from "node:crypto";
import type { BackgroundCompactionSettings } from "@app/ai-proxy/lib/sessions/settings";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";

/**
 * Background compaction, the proxy's copy of Codex's `async_compaction` (codex-rs, off by default there in 2026-10):
 * when a Claude Code session on a Codex model nears its compaction point, the proxy compacts the turn it just sent, in
 * the background, while the session works on. When Claude Code then sends its compaction turn (auto, `/compact` or
 * idle), the proxy answers at once with that item, and keeps the turns that came after it verbatim behind it.
 *
 * Claude Code has the same idea built in ("precomputed compaction"), but the server flag `tengu_sepia_moth` that gates
 * it was false on 2026-10-28, and an isolated ccx config has no server flags at all.
 */

export interface BackgroundResult {
    item: Record<string, unknown>;
    /** The login (`accountHash8`) that made the item; only it can read the item. */
    accountHash: string;
    /** How many raw Responses input items the item compacts, and their hash. */
    prefixLength: number;
    prefixHash: string;
    /** The raw input it compacted (markers left as text): the history of the record a used result becomes. */
    prefix: unknown[];
    /** The context of the turn it compacted (input plus cached tokens). */
    contextTokens: number;
    startedAt: number;
    readyAt: number;
    inputTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
}

interface ThreadState {
    inFlight?: Promise<BackgroundResult | undefined>;
    /** The context at the start of the newest run, finished or not. */
    startedTokens?: number;
    result?: BackgroundResult;
}

/** Per Claude Code thread (session id plus system prompt): the main loop and each subagent compact on their own. */
const threads = new Map<string, ThreadState>();

/**
 * The thread of a request: its Claude Code session and the text of its system prompt. Only the text counts: the
 * compaction turn marks the system blocks for the cache differently than a normal turn does (`ttl: "1h"` on one and
 * not the other, 2026-10-28), and hashing the marks gave the two turns of one thread different keys.
 */
export function backgroundKey(claudeSessionId: string, system: unknown): string {
    const text =
        typeof system === "string"
            ? system
            : Array.isArray(system)
              ? system.map((block) => (isObject(block) && typeof block.text === "string" ? block.text : "")).join("\n")
              : "";
    return `${claudeSessionId}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

export function prefixHash(items: unknown[]): string {
    const hash = createHash("sha256");

    for (const item of items) {
        hash.update(SafeJSON.stringify(item) ?? "null");
        hash.update("\n");
    }

    return hash.digest("hex");
}

/** Claude Code's compaction point for a ccx session record: its window times its compact percent. */
export function compactionPoint(record: { window?: number; compactPercent?: number } | undefined): number | undefined {
    if (!record?.window || !record.compactPercent) {
        return undefined;
    }

    return Math.floor((record.window * record.compactPercent) / 100);
}

/** Whether a turn with this much context should start a background run now. */
export function shouldStartBackground(input: {
    key: string;
    contextTokens: number;
    point: number;
    settings: BackgroundCompactionSettings;
}): boolean {
    const { contextTokens, point, settings } = input;

    if (!settings.enabled || contextTokens < settings.startAt * point) {
        return false;
    }

    const state = threads.get(input.key);

    if (state?.inFlight) {
        return false;
    }

    return (
        state?.startedTokens === undefined || contextTokens - state.startedTokens >= settings.refreshFraction * point
    );
}

/** Registers a run; its result replaces an older one when it finishes, unless the thread was cleared meanwhile. */
export function trackBackground(key: string, contextTokens: number, run: Promise<BackgroundResult | undefined>): void {
    const state: ThreadState = { ...threads.get(key), startedTokens: contextTokens };
    const tracked = run.then((result) => {
        if (threads.get(key) === state) {
            state.inFlight = undefined;

            if (result) {
                state.result = result;
            }
        }

        return result;
    });
    state.inFlight = tracked;
    threads.set(key, state);
}

/** The run in flight for this thread, if any: a compaction turn waits for it instead of starting a second request. */
export function backgroundInFlight(key: string): Promise<BackgroundResult | undefined> | undefined {
    return threads.get(key)?.inFlight;
}

export function backgroundResult(key: string): BackgroundResult | undefined {
    return threads.get(key)?.result;
}

/** Forget a thread's result once a compaction consumed it or proved it stale. */
export function clearBackground(key: string): void {
    threads.delete(key);
}

export type BackgroundMatch =
    | { use: true; tail: unknown[] }
    | { use: false; reason: "login_changed" | "history_changed" | "tail_too_large" };

/**
 * Whether a finished run can answer this compaction turn: the same login, the turn's raw input starting with exactly
 * the input the run compacted, and not too much after it (the next turns would reach the compaction point again).
 */
export function matchBackground(input: {
    result: BackgroundResult;
    rawInput: unknown[];
    accountHash: string;
    point: number;
    tailTokens: (items: unknown[]) => number;
    settings: BackgroundCompactionSettings;
}): BackgroundMatch {
    const { result, rawInput } = input;

    if (result.accountHash !== input.accountHash) {
        return { use: false, reason: "login_changed" };
    }

    if (
        rawInput.length < result.prefixLength ||
        prefixHash(rawInput.slice(0, result.prefixLength)) !== result.prefixHash
    ) {
        return { use: false, reason: "history_changed" };
    }

    const tail = rawInput.slice(result.prefixLength);

    if (input.tailTokens(tail) > input.settings.maxTailFraction * input.point) {
        return { use: false, reason: "tail_too_large" };
    }

    return { use: true, tail };
}

/** A rough token count for a tail of Responses input items: 4 characters per token, as Claude Code estimates. */
export function estimateTokens(items: unknown[]): number {
    return Math.ceil((SafeJSON.stringify(items) ?? "").length / 4);
}

/**
 * What the agent must tell the user after a wasted background run, sent once with the thread's next turn. A line in
 * the compaction summary alone was ignored in the live test of 2026-10-28 (the agent answered only the question).
 */
const pendingNotices = new Map<string, string>();

export function setPendingNotice(key: string, notice: string): void {
    pendingNotices.set(key, notice);
}

export function takePendingNotice(key: string): string | undefined {
    const notice = pendingNotices.get(key);
    pendingNotices.delete(key);
    return notice;
}

/** The input with one reminder added to its last user message: the newest part, so the cached prefix stays whole. */
export function withUserReminder(input: unknown[], text: string): unknown[] {
    const at = input.findLastIndex((item) => isObject(item) && item.role === "user");
    const message = input[at];

    if (!isObject(message)) {
        return input;
    }

    const reminder = { type: "input_text", text: `<system-reminder>\n${text}\n</system-reminder>` };
    const content =
        typeof message.content === "string"
            ? [{ type: "input_text", text: message.content }, reminder]
            : Array.isArray(message.content)
              ? [...message.content, reminder]
              : [reminder];

    return input.map((item, index) => (index === at ? { ...message, content } : item));
}

/** Tests start clean. */
export function resetBackgroundForTests(): void {
    threads.clear();
    pendingNotices.clear();
}
