import { answerDoorJob, type DoorWorkerMessage } from "./door-runner";
import { HUB_SERVER_DOORS } from "./doors";

declare const self: Worker;

// The hub server's heavy doors, on their own thread (DoorWorkerRunner): the server's event loop keeps answering
// every other door while one of these folds a large session.
const running = new Map<number, AbortController>();

self.onmessage = async (event: MessageEvent<DoorWorkerMessage>) => {
    const message = event.data;
    if (message.op === "cancel") {
        running.get(message.id)?.abort();
        return;
    }

    if (message.op === "release") {
        const { releaseMemory } = await import("@genesiscz/utils/process/release-memory");
        releaseMemory();
        Bun.gc(true);
        return;
    }

    const controller = new AbortController();
    running.set(message.id, controller);
    try {
        self.postMessage(await answerDoorJob(message, HUB_SERVER_DOORS, controller.signal));
    } finally {
        running.delete(message.id);
    }
};
