import { readFileSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { findCodexRollout, isCodexRollout, parseCodexRollout } from "./codex";
import { type ComputedSessionChanges, computeSessionChanges, type SessionChangesInput } from "./compute";
import { findClaudeTranscript, readClaudeTranscript } from "./transcript";
import type { SessionTranscript } from "./types";

export { findCodexRollout, isCodexRollout, parseCodexRollout } from "./codex";
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
    repoRootOf,
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

function readTranscript(sessionId: string, path: string): SessionTranscript {
    return isCodexRollout(path) ? parseCodexRollout(sessionId, readFileSync(path, "utf8")) : readClaudeTranscript(path);
}

/**
 * One session's changes from disk: its Claude transcript (found by id under every project
 * directory, subagents included) or its Codex rollout (the patch items Codex recorded), plus
 * whatever change log rows the caller read. A session with neither (Grok, or a deleted one) is
 * judged from the log alone.
 */
export function loadSessionChanges(
    input: Omit<SessionChangesInput, "transcript"> & { transcriptPath?: string | null }
): ComputedSessionChanges & { transcriptPath: string | null } {
    const transcriptPath =
        input.transcriptPath === undefined
            ? (findClaudeTranscript(input.sessionId) ?? findCodexRollout(input.sessionId))
            : input.transcriptPath;
    const transcript = transcriptPath ? readTranscript(input.sessionId, transcriptPath) : null;
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
