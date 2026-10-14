import { describe, expect, test } from "bun:test";
import { toWorkerEvent } from "./worker-stream";

describe("codex worker stream", () => {
    test("an app-server error shows its nested message and the dropped stream's status", () => {
        const event = toWorkerEvent({
            source: "app-server",
            method: "error",
            params: {
                threadId: "thread-1",
                error: {
                    message: "Reconnecting... 3/5",
                    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
                },
            },
        });
        expect(event).toMatchObject({ kind: "error", message: "Reconnecting... 3/5 (stream dropped, HTTP 503)" });
        expect(toWorkerEvent({ source: "app-server", method: "error", params: { message: "flat" } })).toMatchObject({
            message: "flat",
        });
        expect(toWorkerEvent({ source: "app-server", method: "error", params: {} })).toMatchObject({
            message: "unknown codex error",
        });
    });
});
