import { logger } from "@genesiscz/utils/logger";
import { agentFailureCaller } from "./agent-caller";
import type { FailureCaller } from "./record";

declare const self: Worker;

/**
 * Who ran the tool, for a `deadline` record (deadline.ts). The agent identity read is synchronous (transcript lookups,
 * `git` spawns), so it runs on this thread, where the expiry can stop waiting for it and terminate it.
 */
let caller: FailureCaller | null = null;

try {
    caller = agentFailureCaller();
} catch (error) {
    logger.debug({ error }, "failures: no caller context for a command deadline");
}

self.postMessage(caller);
