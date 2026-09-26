import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { listAgentSessionRows, POLLED_LISTING_REUSE_MS } from "@app/ai/lib/sessions/agent-session-rows";
import { costOf, DEFAULT_PRICING, priceFor, resolvePrice } from "@app/ai-spend/lib/pricing";
import { DASHBOARD_ACTOR, type HandoffDeps, type PostHandoffResponse, postHandoff } from "@app/handoff/executor";
import { resumeCommandLine } from "@genesiscz/utils/agent-sessions";
import {
    allTranscriptTurns,
    type ResolvedTranscript,
    resolveTranscript,
    type TranscriptTurn,
    transcriptEnvelope,
} from "@genesiscz/utils/ai/transcripts";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { composeHandoff, type HandoffDraft, type HandoffMeta, type HandoffRange } from "./handoff";
import { codexModelOf, readTail, scanClaudeNative, toolInputKeys } from "./native";
import { readStuckThresholds, stuckVerdict } from "./stuck";
import { buildToolStats, buildTurnCosts, type CallPricer } from "./timeline";
import type { NativeScan, SessionInsights, SessionStuck, StuckThresholds } from "./types";

export { composeHandoff, DEFAULT_HANDOFF_PROMPTS, HandoffRangeError } from "./handoff";
export {
    defaultStuckThresholds,
    parseThresholdFlag,
    readStuckThresholds,
    STUCK_LIMITS,
    stuckConfigPath,
    updateStuckThresholds,
} from "./stuck";
export type * from "./types";

const log = logger.child({ component: "hub/insights" });

/** Bump when the cached JSON's shape changes. */
const CACHE_VERSION = 1;
const CACHE_TTL = "7 days";
/** The stuck detector reads this much of the file's end for full tool inputs. */
const TAIL_BYTES = 2 * 1024 * 1024;
/** Turns the stuck detector reads: enough for a long loop inside one prompt. */
const STUCK_TURNS = 120;

export const INSIGHTS_PRICING_NOTE =
    "List prices from the model catalog (the rates tools ai-spend uses), per model call; an estimate, not a bill";

/** List price per call from the catalog, with its dated and context-banded rules applied. */
export function catalogPricer(): CallPricer {
    return (call) => {
        if (!call.model) {
            return null;
        }

        const entry = priceFor(call.model, DEFAULT_PRICING);

        if (!entry) {
            return null;
        }

        const at = call.at ? new Date(call.at) : undefined;
        const price = resolvePrice(entry, {
            ...(at && !Number.isNaN(at.getTime()) ? { at } : {}),
            contextTokens: call.input + call.cacheRead + call.cacheWrite,
        });
        return costOf(
            { input: call.input, output: call.output, cacheWrite: call.cacheWrite, cacheRead: call.cacheRead },
            price
        );
    };
}

function readText(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch (err) {
        log.warn({ err, path }, "session file unreadable");
        return null;
    }
}

function fileStamp(resolved: ResolvedTranscript): string {
    const files = [...(resolved.extraFiles ?? []), resolved.filePath];
    return files
        .map((file) => {
            const stat = statSync(file);
            return `${stat.size}-${Math.round(stat.mtimeMs)}`;
        })
        .join("_");
}

interface Loaded {
    resolved: ResolvedTranscript;
    turns: TranscriptTurn[];
    native: NativeScan | null;
    defaultModel: string | null;
}

async function loadTranscript(resolved: ResolvedTranscript): Promise<Loaded> {
    const turns = await allTranscriptTurns(resolved);
    let native: NativeScan | null = null;
    let defaultModel: string | null = null;

    if (resolved.source === "native" && (resolved.provider === "claude" || resolved.provider === "codex")) {
        const text = readText(resolved.filePath);

        if (text !== null) {
            if (resolved.provider === "claude") {
                native = scanClaudeNative(text);
            } else {
                defaultModel = codexModelOf(text);
            }
        }
    }

    log.debug(
        {
            sessionId: resolved.sessionId,
            provider: resolved.provider,
            turns: turns.length,
            calls: native?.calls.length,
        },
        "insights transcript loaded"
    );
    return { resolved, turns, native, defaultModel };
}

/** The verdict for one resolved transcript, from its tail only (cheap even for a huge file). */
async function stuckOf(resolved: ResolvedTranscript, thresholds: StuckThresholds, now: number) {
    const envelope = await transcriptEnvelope(resolved, { limit: STUCK_TURNS });
    let inputKeys: Map<string, string> | undefined;

    try {
        inputKeys = toolInputKeys(readTail(resolved.filePath, TAIL_BYTES), resolved.provider);
    } catch (err) {
        log.debug({ err, path: resolved.filePath }, "stuck: no tail for full tool inputs; comparing key arguments");
    }

    return stuckVerdict({
        turns: envelope.turns,
        turnOffset: envelope.nextOffset - envelope.turns.length,
        now,
        thresholds,
        ...(inputKeys ? { inputKeys } : {}),
        terminated: envelope.terminated === "end" || envelope.terminated === "error",
    });
}

export interface InsightsOptions {
    sessionId: string;
    /** Skip the cache (a changed pricing table, a debugging run). */
    fresh?: boolean;
    now?: number;
    storage?: Storage;
}

/**
 * Timeline, tool analytics and the stuck verdict of one session. The heavy part (every turn and the
 * native scan) is cached per file size and mtime, so an unchanged session answers from disk; the
 * stuck verdict depends on the clock and is always computed fresh from the tail.
 */
export async function sessionInsights(options: InsightsOptions): Promise<SessionInsights> {
    const now = options.now ?? Date.now();
    const storage = options.storage ?? new Storage("hub");
    const resolved = await resolveTranscript(options.sessionId);
    const thresholds = readStuckThresholds();
    const key = `insights/${resolved.sessionId}-${fileStamp(resolved)}-v${CACHE_VERSION}.json`;

    if (!options.fresh) {
        const hit = await storage.getCacheFile<SessionInsights>(key, CACHE_TTL);

        if (hit) {
            log.debug({ key }, "insights cache hit");
            return {
                ...hit,
                stuck: await stuckOf(resolved, thresholds, now),
                thresholds,
                generatedAt: new Date(now).toISOString(),
            };
        }
    }

    const loaded = await loadTranscript(resolved);
    const costs = buildTurnCosts({
        turns: loaded.turns,
        native: loaded.native,
        defaultModel: loaded.defaultModel,
        price: catalogPricer(),
    });
    const tools = buildToolStats({ turns: loaded.turns, native: loaded.native });
    // The same tail read as a cache hit and `tools hub stuck`, so all three print one verdict.
    const stuck = await stuckOf(resolved, thresholds, now);
    const firstPrompt = loaded.turns.find((turn) => turn.role === "user");
    const result: SessionInsights = {
        sessionId: resolved.sessionId,
        provider: resolved.provider,
        filePath: resolved.filePath,
        title: firstPrompt ? firstPrompt.text.split("\n", 1)[0]?.trim().slice(0, 120) || null : null,
        cwd: loaded.native?.cwd ?? null,
        branch: loaded.native?.branch ?? null,
        turnCount: loaded.turns.length,
        priced: costs.priced,
        pricingNote: INSIGHTS_PRICING_NOTE,
        totals: costs.totals,
        turns: costs.turns,
        tools,
        stuck,
        thresholds,
        generatedAt: new Date(now).toISOString(),
    };
    await storage.putCacheFile(key, { ...result, stuck: null }, CACHE_TTL);
    log.debug(
        {
            sessionId: resolved.sessionId,
            turns: result.turnCount,
            sections: result.turns.length,
            tools: result.tools.length,
            priced: result.priced,
            stuck: result.stuck?.kind ?? null,
        },
        "insights computed"
    );
    return result;
}

export interface StuckOptions {
    /** Check these sessions; none discovers every session active within `maxAgeHours`. */
    sessionIds?: string[];
    thresholds?: StuckThresholds;
    now?: number;
}

/** Verdicts for the given sessions, or for every recently active one. A session that fails to read carries `error`. */
export async function stuckSessions(options: StuckOptions = {}): Promise<SessionStuck[]> {
    const now = options.now ?? Date.now();
    const thresholds = options.thresholds ?? readStuckThresholds();
    const targets: { resolved: () => Promise<ResolvedTranscript>; id: string; title: string | null }[] = [];

    if (options.sessionIds && options.sessionIds.length > 0) {
        for (const id of new Set(options.sessionIds)) {
            targets.push({ id, title: null, resolved: () => resolveTranscript(id) });
        }
    } else {
        const rows = await listAgentSessionRows({
            hours: thresholds.maxAgeHours,
            withUsage: false,
            maxDiscoveryAgeMs: POLLED_LISTING_REUSE_MS,
        });
        log.debug({ rows: rows.length, hours: thresholds.maxAgeHours }, "stuck: discovered sessions");

        for (const row of rows.filter((candidate) => !candidate.archived)) {
            targets.push({
                id: row.sessionId,
                title: row.title,
                resolved: async () => ({
                    provider: row.provider,
                    source: "native",
                    sessionId: row.sessionId,
                    filePath: row.filePath,
                }),
            });
        }
    }

    return Promise.all(
        targets.map(async (target): Promise<SessionStuck> => {
            try {
                const resolved = await target.resolved();
                return {
                    sessionId: resolved.sessionId,
                    provider: resolved.provider,
                    title: target.title,
                    verdict: await stuckOf(resolved, thresholds, now),
                };
            } catch (err) {
                log.warn({ err, sessionId: target.id }, "stuck: transcript unreadable");
                return {
                    sessionId: target.id,
                    provider: "claude",
                    title: target.title,
                    verdict: null,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        })
    );
}

export interface HandoffOptions {
    sessionId: string;
    range: HandoffRange;
    /** Overrides for what the transcript cannot say (the hub knows the session's title). */
    title?: string | null;
    cwd?: string | null;
    branch?: string | null;
    account?: string | null;
}

export interface HandoffResult extends HandoffDraft {
    sessionId: string;
    provider: string;
}

/** The handoff markdown for a range of one session's prompts. */
export async function sessionHandoff(options: HandoffOptions): Promise<HandoffResult> {
    const resolved = await resolveTranscript(options.sessionId);
    const loaded = await loadTranscript(resolved);
    const cwd = options.cwd ?? loaded.native?.cwd ?? null;
    const meta: HandoffMeta = {
        sessionId: resolved.sessionId,
        provider: resolved.provider,
        title: options.title ?? null,
        cwd,
        branch: options.branch ?? loaded.native?.branch ?? null,
        resumeCommand: resumeCommandLine(resolved.provider, resolved.sessionId, { account: options.account ?? null }),
    };
    const draft = composeHandoff({ turns: loaded.turns, meta, range: options.range });
    log.debug(
        { sessionId: resolved.sessionId, from: draft.fromNumber, to: draft.toNumber, open: draft.openItems.length },
        "handoff composed"
    );
    return { ...draft, sessionId: resolved.sessionId, provider: resolved.provider };
}

/** `handoff-<id8>-p<from>-<to>.md` inside `dir`, written atomically. Returns the absolute path. */
export function saveHandoff(draft: HandoffResult, dir: string): string {
    const folder = resolve(dir);
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `handoff-${draft.sessionId.slice(0, 8)}-p${draft.fromNumber}-${draft.toNumber}.md`);
    atomicWriteFileSync(path, draft.markdown);
    log.debug({ path }, "handoff saved");
    return path;
}

/**
 * Posts the draft to the handoff store (`handoff_post`): the markdown is the description, each open
 * item a task. `owner` posts as the human owner (the hub), in the session's folder, instead of as
 * the calling agent.
 */
export function postSessionHandoff(
    draft: HandoffResult,
    options: {
        owner?: boolean;
        cwd?: string | null;
        branch?: string | null;
        /** The handoff log and database (tests). */
        store?: Pick<HandoffDeps, "base" | "dbPath">;
    } = {}
): PostHandoffResponse {
    const tasks =
        draft.openItems.length > 0
            ? draft.openItems.map((text) => ({ text }))
            : [{ text: "Continue the session's work from the handoff notes", acceptanceCriteria: "The goal is met" }];
    const response = postHandoff(
        { title: draft.title, description: draft.markdown, tasks, refs: [draft.sessionId] },
        {
            ...options.store,
            ...(options.owner
                ? {
                      by: {
                          ...DASHBOARD_ACTOR,
                          sessionTitle: "hub handoff composer",
                          cwd: options.cwd ?? null,
                          branch: options.branch ?? null,
                      },
                  }
                : {}),
        }
    );
    log.debug({ handoff: response.handoff.id, sessionId: draft.sessionId }, "handoff posted from a session draft");
    return response;
}
