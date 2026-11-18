import { createHash } from "node:crypto";
import type { HistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import { changesCache } from "@genesiscz/utils/agent-sessions/readers/changes-window-cache";
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
    changesFilesystem,
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

interface RecentAnswer {
    key: string;
    unchanged: () => boolean;
    changes: ComputedSessionChanges & { transcriptPath: string };
}
function copyAnswer(changes: RecentAnswer["changes"]): RecentAnswer["changes"] {
    const { blobs, ...rest } = changes;
    return { ...structuredClone(rest), blobs: new Map(Array.from(blobs, ([oid, bytes]) => [oid, Buffer.from(bytes)])) };
}
const answers = changesCache<{ last?: RecentAnswer }>("session-changes recent answers");

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
    const verify = env.agents.verifyChangesWindow();
    const hash = createHash("sha256");
    for (let i = 0; i < rows.length; i += 128) {
        hash.update(SafeJSON.stringify(rows.slice(i, i + 128), { strict: true }));
    }
    const key = `${count}:${input.initialTurns}:${hash.digest("hex")}`;
    const entry = answers.get(sessionId, () => ({}));
    if (!verify && entry.last?.key === key && entry.last.unchanged()) {
        log.debug({ session: sessionId, count, rounds: 0 }, "recent session changes");
        return copyAnswer(entry.last.changes);
    }
    entry.last = undefined;
    const filesystem = changesFilesystem();
    const full = () => loadSessionChanges({ sessionId, log: rows, ...filesystem });
    let priorProviders: string[] = [];
    const remember = (result: ReturnType<typeof full>, window?: SessionChangesWindow) => {
        const current = window?.unchanged;
        if (current && !verify && result.transcriptPath && result.transcriptPath === window?.transcriptPath) {
            entry.last = {
                key,
                changes: copyAnswer({ ...result, transcriptPath: result.transcriptPath }),
                unchanged: () =>
                    priorProviders.every(
                        (kind) => !historyProvider(kind).reader.readChangesWindow(sessionId, { turns: requested })
                    ) &&
                    current() &&
                    filesystem.unchanged(),
            };
        }
        return result;
    };
    let requested = input.initialTurns ?? Math.max(2 * count, 8);
    let round = 1;
    const covers = new Set<string>();
    let settled: { changes: ComputedSessionChanges; unchanged: () => boolean } | undefined;
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
        priorProviders = [];
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
            priorProviders.push(kind);
        }
        if (!window || window.complete) {
            return remember(fallback(window ? "F1" : "F4"), window);
        }
        const current = window;
        const { changes, cover, triggers } = profiler
            .scope("session-changes")
            .measure("compute", () =>
                computeChanges(
                    { sessionId, log: rows, transcript: current.transcript, ...filesystem },
                    current,
                    settled?.unchanged() ? settled.changes : undefined
                )
            );
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
            if (verify) {
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
                    input.onRound?.({
                        round,
                        requested,
                        changed,
                        late: window.lateResultCovers ?? 0,
                        ...triggers,
                        fallback: "verification mismatch",
                    });
                    return expected;
                }
            }
            return remember({ ...changes, transcriptPath: window.transcriptPath }, window);
        }
        for (const id of cover) {
            covers.add(id);
        }
        settled = !cover.length && window.unchanged ? { changes, unchanged: window.unchanged } : undefined;
        // A writer cover can expose another writer one turn earlier, even when we already have enough changes.
        requested = Math.min(window.sessionTurns, 2 * Math.max(1, requested, window.windowTurns));
    }
    return fallback("F2");
}
