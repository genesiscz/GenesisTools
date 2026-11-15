import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BoundedCommandResult } from "@genesiscz/utils/process/bounded-command";

let next: BoundedCommandResult = { status: 0, signal: null, stdout: "", stderr: "" };

mock.module("@genesiscz/utils/process/bounded-command", () => ({
    boundedCommand: async () => next,
}));

const { sendT3ThreadMessage } = await import("./thread-cli");

afterAll(() => {
    mock.restore();
});

describe("sendT3ThreadMessage outcome of a cut-short send", () => {
    beforeEach(() => {
        next = { status: 0, signal: null, stdout: "", stderr: "" };
    });

    test("a plain error exit is a refusal", async () => {
        next = { status: 1, signal: null, stdout: "", stderr: "no such thread" };
        expect((await sendT3ThreadMessage("t1", "hi", "/fake/t3")).kind).toBe("refused");
    });

    test("the watchdog's 124 and a signal exit (128 + N) are unknown, so nothing retries blindly", async () => {
        for (const status of [124, 137, 143]) {
            next = { status, signal: null, stdout: "", stderr: "" };
            expect((await sendT3ThreadMessage("t1", "hi", "/fake/t3")).kind).toBe("unknown");
        }
    });

    test("a spawn error is unknown", async () => {
        next = { status: 1, signal: null, stdout: "", stderr: "", error: new Error("spawn failed") };
        expect((await sendT3ThreadMessage("t1", "hi", "/fake/t3")).kind).toBe("unknown");
    });

    test("a receipt is sent", async () => {
        next = { status: 0, signal: null, stdout: '{"messageId":"m1","runId":null,"delivery":"queued"}', stderr: "" };
        expect(await sendT3ThreadMessage("t1", "hi", "/fake/t3")).toMatchObject({ kind: "sent", messageId: "m1" });
    });
});
