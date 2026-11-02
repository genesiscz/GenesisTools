import type { HistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import type { SessionChangesRead } from "@genesiscz/utils/agent-sessions/types";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { requireSibling } from "@genesiscz/utils/fs/module-dir";
import { logger } from "@genesiscz/utils/logger";
import { type ComputedSessionChanges, computeSessionChanges, type SessionChangesInput } from "./compute";

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
export type { TranscriptSource } from "./transcript";
export {
    applyReplacement,
    fileToolVia,
    findClaudeTranscript,
    isShellTool,
    parseClaudeTranscript,
    readClaudeTranscript,
} from "./transcript";
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
 * subagent transcripts, Codex's rollout patch items), plus whatever change log rows the caller read. A session no
 * reader has a transcript for (Grok, or a deleted one) is judged from the log alone.
 */
export function loadSessionChanges(
    input: Omit<SessionChangesInput, "transcript">
): ComputedSessionChanges & { transcriptPath: string | null } {
    const read = readTranscript(input.sessionId);
    const transcriptPath = read?.transcriptPath ?? null;
    const transcript = read?.transcript ?? null;
    log.debug(
        {
            session: input.sessionId,
            transcriptPath,
            logRows: input.log?.length ?? 0,
            calls: transcript?.calls.length ?? 0,
        },
        "computing session changes"
    );

    return { ...computeSessionChanges({ ...input, transcript }), transcriptPath };
}
