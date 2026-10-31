import { readFileSync } from "node:fs";
import { claudeMessagesToTurns } from "@genesiscz/utils/ai/transcripts/claude";
import { toolInputKeysOf } from "@genesiscz/utils/ai/transcripts/native-scan";
import { parseTranscriptLine } from "@genesiscz/utils/ai/transcripts/parse-line";
import { isRecord } from "@genesiscz/utils/ai/transcripts/resolve-core";
import { workerEventsToTurns } from "@genesiscz/utils/ai/transcripts/worker-events";
import { ClaudeSession } from "@genesiscz/utils/claude/session";
import { parseTurnEvents as parseClaudeTurnEvents } from "@genesiscz/utils/claude/worker-stream";
import type { TranscriptParser } from "@genesiscz/utils/harness/parts";
import { claudeToolInputLine } from "./claude-tool-inputs";
import { claudeWindowTurns } from "./claude-window-turns";

/** Claude transcripts to turns: a session file, or a `claude -p` worker turn file. Moved from `TURN_READERS` in load.ts. */
export const claudeParse: TranscriptParser = {
    fromFile: async (resolved, path, index) => {
        if (resolved.source === "worker") {
            // A `claude -p --output-format stream-json` turn file, not a session file.
            return workerEventsToTurns(
                parseClaudeTurnEvents(readFileSync(path, "utf8"), resolved.sessionId),
                resolved.sessionId,
                index
            );
        }

        const session = await ClaudeSession.fromFile(path);
        return claudeMessagesToTurns(session.messages);
    },
    // The end of a file too large to parse whole: a worker's stream-json events, or a session's conversation rows.
    fromLines: (resolved, lines) =>
        resolved.source === "worker"
            ? workerEventsToTurns(parseClaudeTurnEvents(lines.join("\n"), resolved.sessionId), resolved.sessionId, 1)
            : claudeWindowTurns(lines.map(parseTranscriptLine).filter(isRecord)),
    toolInputKeys: (text) => toolInputKeysOf(text, claudeToolInputLine),
};
