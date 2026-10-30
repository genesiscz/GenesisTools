import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { BackgroundCompactionSettings } from "@app/ai-proxy/lib/sessions/settings";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { claudeCodeThreadKey } from "@app/ai-proxy/lib/translators/formats/anthropic/claude-code-turns";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { atomicWriteFileSync, isMissingFileError } from "@genesiscz/utils/storage/atomic-file";

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

/** The thread of a request; see `claudeCodeThreadKey`. */
export const backgroundKey = claudeCodeThreadKey;

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

    const state = threadState(input.key);

    if (state?.inFlight) {
        return false;
    }

    return (
        state?.startedTokens === undefined || contextTokens - state.startedTokens >= settings.refreshFraction * point
    );
}

/** Why a finished run was never used. */
export type BackgroundDiscard = "superseded";

/**
 * A ready run waits on disk too, so a proxy restart does not lose it (17 restarts in session 8cf9eff2; one lost run
 * had read 363K tokens). One file per thread, removed when the run is used or cleared; older than a day is stale.
 */
const PERSISTED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function persistedPath(key: string): string {
    const name = createHash("sha256").update(key).digest("hex").slice(0, 32);
    return join(getAiProxyStorage().getBaseDir(), "background", `${name}.json`);
}

/** Threads this process saved a run for. */
const persistedKeys = new Set<string>();

function persist(key: string, result: BackgroundResult): void {
    const path = persistedPath(key);
    persistedKeys.add(key);

    try {
        mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
        atomicWriteFileSync(path, SafeJSON.stringify({ key, result }), { mode: 0o600 });
    } catch (error) {
        logger.warn({ err: error, key }, "ai-proxy: could not save a background compaction; a restart loses it");
    }
}

function isBackgroundResult(value: unknown): value is BackgroundResult {
    if (!isObject(value)) {
        return false;
    }

    return (
        isObject(value.item) &&
        typeof value.accountHash === "string" &&
        typeof value.prefixHash === "string" &&
        Array.isArray(value.prefix) &&
        [value.prefixLength, value.contextTokens, value.startedAt, value.readyAt].every(
            (number) => typeof number === "number" && Number.isFinite(number) && number >= 0
        ) &&
        [value.inputTokens, value.cachedTokens, value.outputTokens].every(
            (number) => number === undefined || (typeof number === "number" && Number.isFinite(number) && number >= 0)
        )
    );
}

/** Remove expired background data even when its thread is never opened again. */
export function sweepBackgroundCompactions(retentionDays: number, now = Date.now()): string[] {
    const dir = join(getAiProxyStorage().getBaseDir(), "background");
    if (!existsSync(dir)) {
        return [];
    }

    const removed: string[] = [];
    for (const name of readdirSync(dir)) {
        if (!/^[0-9a-f]{32}\.json(?:\.\d+\.\d+\.\d+\.tmp)?$/.test(name)) {
            continue;
        }
        const path = join(dir, name);
        try {
            if (statSync(path).mtimeMs < now - retentionDays * 86_400_000) {
                unlinkSync(path);
                removed.push(name);
            }
        } catch (error) {
            if (!isMissingFileError(error)) {
                logger.warn({ error, name }, "ai-proxy: could not sweep background compaction");
            }
        }
    }
    return removed;
}

function readPersisted(key: string): BackgroundResult | undefined {
    const path = persistedPath(key);

    if (!existsSync(path)) {
        return undefined;
    }

    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        logger.warn({ err: error, key }, "ai-proxy: a saved background compaction could not be read");
        return undefined;
    }

    let saved: unknown;
    try {
        saved = SafeJSON.parse(text, { strict: true });
    } catch (error) {
        logger.warn({ err: error, key }, "ai-proxy: a saved background compaction is malformed");
        forgetPersisted(key);
        return undefined;
    }

    if (
        !isObject(saved) ||
        saved.key !== key ||
        !isBackgroundResult(saved.result) ||
        Date.now() - saved.result.readyAt > PERSISTED_MAX_AGE_MS
    ) {
        forgetPersisted(key);
        return undefined;
    }

    return saved.result;
}

/** The thread's state, loaded from its saved run when this process has none (after a restart). */
function threadState(key: string): ThreadState | undefined {
    const known = threads.get(key);

    if (known) {
        return known;
    }

    const saved = readPersisted(key);

    if (!saved) {
        return undefined;
    }

    const state: ThreadState = { result: saved, startedTokens: saved.contextTokens };
    threads.set(key, state);
    return state;
}

function forgetPersisted(key: string): void {
    persistedKeys.delete(key);

    try {
        unlinkSync(persistedPath(key));
    } catch (error) {
        if (!isMissingFileError(error)) {
            logger.warn({ error, key }, "ai-proxy: could not remove background compaction");
        }
    }
}

/**
 * Tracks a run for a thread. `onDiscard` hears of a finished result that was never used: an older ready result that
 * a newer one replaces, or a run that finished after a newer run took the thread over.
 */
export function trackBackground(
    key: string,
    contextTokens: number,
    run: Promise<BackgroundResult | undefined>,
    onDiscard?: (result: BackgroundResult, reason: BackgroundDiscard) => void
): void {
    const state: ThreadState = { ...threadState(key), startedTokens: contextTokens };
    const tracked = run.then((result) => {
        const current = threads.get(key);

        if (current === state) {
            state.inFlight = undefined;

            if (result) {
                if (state.result) {
                    onDiscard?.(state.result, "superseded");
                }

                state.result = result;
                persist(key, result);
            }
        } else if (result && current) {
            onDiscard?.(result, "superseded");
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
    return threadState(key)?.result;
}

/** Forget a thread's result once a compaction consumed it or proved it stale. */
export function clearBackground(key: string): void {
    threads.delete(key);
    forgetPersisted(key);
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
    for (const key of [...persistedKeys]) {
        forgetPersisted(key);
    }

    threads.clear();
    pendingNotices.clear();
}

/** A proxy restart: the process forgets its threads, the saved runs stay. */
export function forgetBackgroundInMemoryForTests(): void {
    threads.clear();
}
