import { stat } from "node:fs/promises";
import { logger } from "@genesiscz/utils/logger";

/**
 * Modification time of a vendor credential file, in epoch ms.
 *
 * This is how the poll gate learns that an account was repaired. Anthropic logs in through
 * us, so `tools claude login` clears its backoff directly; codex and grok log in through
 * their own CLIs (`codex login`, `grok`), which we cannot hook at all. Without a stamp a
 * user who fixed a dead session still watched the card replay the old error for up to six
 * hours, with nothing on screen saying the account was merely paused.
 *
 * Undefined when the file is missing or unreadable, which the gate reads as "no evidence
 * of a repair" and leaves the block standing.
 */
export async function fileMtimeMs(path: string): Promise<number | undefined> {
    try {
        return (await stat(path)).mtimeMs;
    } catch (err) {
        logger.debug({ err, path }, "[usage] credential file has no readable stamp");
        return undefined;
    }
}
