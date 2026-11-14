import { logger } from "@genesiscz/utils/logger";
import { appendFailure, isToolFailure } from "./record";

declare const self: Worker;

/**
 * Writes one `deadline` record for deadline.ts. `appendFailure` is synchronous (`mkdirSync`, `appendFileSync`), so a
 * log filesystem that blocks would freeze the thread of the call that expired; on this thread the expiry can stop
 * waiting for the write and terminate it. Answers whether the record was written.
 */
self.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data;
    let written = false;

    if (
        typeof data === "object" &&
        data !== null &&
        "failure" in data &&
        "dir" in data &&
        isToolFailure(data.failure) &&
        typeof data.dir === "string"
    ) {
        try {
            appendFailure(data.failure, data.dir);
            written = true;
        } catch (error) {
            logger.debug({ error, failureId: data.failure.id }, "failures: the deadline record was not written");
        }
    }

    self.postMessage(written);
};
