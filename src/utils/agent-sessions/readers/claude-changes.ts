import { readClaudeTranscriptFolded } from "@genesiscz/utils/session-changes/fold";
import { findClaudeTranscript } from "@genesiscz/utils/session-changes/transcript";
import type { SessionChangesRead } from "../types";

/**
 * `NativeSessionReader.readChanges` for Claude: the session's transcript, found by id under every project folder, read
 * together with its sub-agents' transcripts. Folded, so a resident process (the hub server) reads only what the files
 * gained since its last ask. The tool-call parser itself is `session-changes/transcript.ts`.
 */
export function claudeSessionChanges(sessionId: string): SessionChangesRead | null {
    const transcriptPath = findClaudeTranscript(sessionId);

    return transcriptPath ? { transcriptPath, transcript: readClaudeTranscriptFolded(transcriptPath) } : null;
}
