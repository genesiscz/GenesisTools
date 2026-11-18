import type { HistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import type { SessionChangesRead, SessionChangesWindow } from "@genesiscz/utils/agent-sessions/types";
import { readChangeLog } from "@genesiscz/utils/agents/change-log";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { env } from "@genesiscz/utils/env";
import { requireSibling } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import {
    type ComputedSessionChanges,
    computeChanges,
    computeSessionChanges,
    lastChangedTurns,
    type SessionChangesInput,
} from "./compute";

export { repoRootOf } from "@genesiscz/utils/git/repo-root";
export type { AnalyzeCommandInput, CommandAnalysis, StageKind } from "./command";
export {
    analyzeCommand,
    expandVariables,
    fableSpecPaths,
    heredocBody,
    isLockOrManifest,
    namedBy,
    shellWords,
} from "./command";
export type { ComputedSessionChanges, SessionChangesInput } from "./compute";
export {
    computeSessionChanges,
    gitBlobOid,
    lastChangedTurns,
    mergeTurnFiles,
    storeBlobs,
} from "./compute";
export type { PathRuleContext } from "./rules";
export { defaultTempDirs, pathExclusion, rootOf } from "./rules";
export { applyReplacement, fileToolVia, isShellTool } from "./tool-calls";
export type {
    BlobStore,
    ChangeConfidence,
    ChangeVia,
    ExcludedFile,
    ExclusionReason,
    LoggedChange,
    SessionChanges,
    SessionToolCall,
    SessionTranscript,
    SessionTurn,
    TurnChanges,
    TurnFile,
} from "./types";

const { log } = logger.scoped("session-changes");

type ProviderDoor = (kind: string) => HistoryProvider;

let providerDoor: ProviderDoor | undefined;

function isProviderDoor(value: unknown): value is ProviderDoor {
    return typeof value === "function";
}

/**
 * `resolveHistoryProvider`, the one door to the providers' readers, loaded on the first read: registering the built-in
 * plugins made importing this module cost 150 ms instead of 47 (measured 2026-11-02), and the users of its light
 * helpers (`blame`, the command analysis) never read a transcript.
 */
function historyProvider(kind: string): HistoryProvider {
    if (!providerDoor) {
        const exports: unknown = requireSibling(import.meta, "../agent-sessions/provider");
        const door: unknown =
            typeof exports === "object" && exports !== null
                ? Reflect.get(exports, "resolveHistoryProvider")
                : undefined;

        if (!isProviderDoor(door)) {
            throw new Error("agent-sessions/provider exports no resolveHistoryProvider");
        }

        providerDoor = door;
    }

    return providerDoor(kind);
}

/**
 * The session's changes as the first provider that has its transcript reads them (`NativeSessionReader.readChanges`), in
 * harness order. A new provider answers through its reader; nothing here knows a transcript format (eve on #640).
 */
function readTranscript(sessionId: string): SessionChangesRead | null {
    for (const kind of ACCOUNT_PROVIDER_ALIASES) {
        const read = historyProvider(kind).reader.readChanges(sessionId);

        if (read) {
            return read;
        }
    }

    return null;
}

/**
 * One session's changes from disk: what its provider's reader reads from its transcript (Claude's main and
 * subagent transcripts, Codex's rollout patch items), plus the session's change log rows: the ones the caller
 * passes in `log`, else the log read here (`readChangeLog`). The log is what holds the files a Bash command
 * changed. A session no reader has a transcript for (Grok, or a deleted one) is judged from the log alone.
 */
export function loadSessionChanges(
    input: Omit<SessionChangesInput, "transcript">
): ComputedSessionChanges & { transcriptPath: string | null } {
    const rows = input.log ?? readChangeLog(input.sessionId);
    const read = readTranscript(input.sessionId);
    const transcriptPath = read?.transcriptPath ?? null;
    const transcript = read?.transcript ?? null;
    log.debug(
        {
            session: input.sessionId,
            transcriptPath,
            logRows: rows.length,
            calls: transcript?.calls.length ?? 0,
        },
        "computing session changes"
    );

    return { ...computeSessionChanges({ ...input, log: rows, transcript }), transcriptPath };
}

export interface ChangesRound {
    round: number;
    requested: number;
    changed: number;
    late: number;
    writers: number;
    rows: number;
    fallback?: string;
}

export function loadRecentSessionChanges(input: {
    sessionId: string;
    count: number;
    log?: SessionChangesInput["log"];
    initialTurns?: number;
    onRound?: (round: ChangesRound) => void;
}): ComputedSessionChanges & { transcriptPath: string | null } {
    using _rounds = profiler.scope("session-changes").section("rounds");
    const { sessionId, count } = input;
    const rows = input.log ?? readChangeLog(sessionId);
    const full = () => loadSessionChanges({ sessionId, log: rows });
    let requested = input.initialTurns ?? Math.max(2 * count, 8);
    let round = 1;
    const covers = new Set<string>();
    const total = { late: 0, writers: 0, rows: 0 };
    const fallback = (reason: string) => {
        const info = { session: sessionId, round, requested, count, ...total, changed: 0, fallback: reason };
        input.onRound?.(info);
        if (reason.startsWith("F7")) {
            log.warn(info, "unknown changes window cover");
        } else {
            log.info(info, "using full session changes");
        }
        return full();
    };

    for (; round <= 17; round++) {
        let window: SessionChangesWindow | undefined;
        for (const kind of ACCOUNT_PROVIDER_ALIASES) {
            const read = historyProvider(kind).reader.readChangesWindow(sessionId, {
                turns: requested,
                cover: [...covers],
            });
            if (read?.supported) {
                window = read.window;
                break;
            }
            if (read && /^F[1-7]/.test(read.reason)) {
                return fallback(read.reason);
            }
        }
        if (!window || window.complete) {
            return fallback(window ? "F1" : "F4");
        }
        const { changes, cover, triggers } = profiler
            .scope("session-changes")
            .measure("compute", () => computeChanges({ sessionId, log: rows, transcript: window.transcript }, window));
        const changed = changes.turns.filter((turn) => turn.files.length).length;
        total.late += window.lateResultCovers ?? 0;
        total.writers += triggers.writers;
        total.rows += triggers.rows;
        input.onRound?.({ round, requested, changed, late: window.lateResultCovers ?? 0, ...triggers });
        if (!cover.length && changed >= count) {
            log.debug(
                {
                    session: sessionId,
                    count,
                    rounds: round,
                    finalTurns: window.windowTurns,
                    changedTurns: changed,
                    covers: total,
                },
                "recent session changes"
            );
            if (env.agents.verifyChangesWindow()) {
                const expected = full();
                const selected = lastChangedTurns(changes, count);
                const other = lastChangedTurns(expected, count);
                const mismatch = selected.findIndex((turn, i) => {
                    const next = other[i];
                    return (
                        !next ||
                        next.turnId !== turn.turnId ||
                        SafeJSON.stringify([turn.files, turn.excluded], { strict: true }) !==
                            SafeJSON.stringify([next.files, next.excluded], { strict: true })
                    );
                });
                if (mismatch !== -1 || selected.length !== other.length) {
                    log.warn(
                        { session: sessionId, turn: selected[mismatch]?.turnId ?? other[selected.length]?.turnId },
                        "window differs from full changes"
                    );
                    return expected;
                }
            }
            return { ...changes, transcriptPath: window.transcriptPath };
        }
        for (const id of cover) {
            covers.add(id);
        }
        if (changed < count) {
            requested *= 2;
        }
    }
    return fallback("F2");
}
