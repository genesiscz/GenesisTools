import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import type { PendingToolCall } from "@genesiscz/utils/agent-sessions/types";
import { logger } from "@genesiscz/utils/logger";
import { readTailAt } from "./native-scan";
import { TURN_TAIL_BYTES, type TurnProvider, tailRecords } from "./turn-state";

/**
 * The newest unanswered tool call of a native transcript, read from its last `TURN_TAIL_BYTES` by the provider's
 * `dialog.pendingCall` member; null when the file cannot be read or holds none. A call older than the tail is missed,
 * which the log says.
 */
export function readPendingCall(provider: TurnProvider, transcriptPath: string): PendingToolCall | null {
    try {
        const tail = readTailAt(transcriptPath, TURN_TAIL_BYTES);

        if (tail.start > 0) {
            logger.debug(
                { transcriptPath, cap: TURN_TAIL_BYTES, skippedBytes: tail.start },
                "pending call read from the transcript tail only"
            );
        }

        return resolveHistoryProvider(provider).reader.dialog.pendingCall(tailRecords(tail).records);
    } catch (error) {
        logger.debug({ error, transcriptPath, provider }, "could not read the transcript for its pending call");
        return null;
    }
}
