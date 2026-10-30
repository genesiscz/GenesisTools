import { readFileSync } from "node:fs";
import { claudeMessagesToTurns } from "@genesiscz/utils/ai/transcripts/claude";
import { workerEventsToTurns } from "@genesiscz/utils/ai/transcripts/worker-events";
import { ClaudeSession } from "@genesiscz/utils/claude/session";
import { parseTurnEvents as parseClaudeTurnEvents } from "@genesiscz/utils/claude/worker-stream";
import type { TranscriptParser } from "@genesiscz/utils/harness/parts";

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
    fromLines: () => [],
};
