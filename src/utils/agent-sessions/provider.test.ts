import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetBuiltInPluginsForTest } from "@genesiscz/utils/ai/providers/plugins";
import { _resetPluginsForTest, registerPlugin } from "@genesiscz/utils/ai/providers/registry";
import {
    acknowledgeSessionMessage,
    cancelSessionMessage,
    enqueueSessionMessage,
    listSessionMessages,
    offerSessionMessage,
} from "./message-queue";
import { resolveHistoryProvider } from "./provider";

afterEach(() => {
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
});

test("a registered fourth history provider can be resolved without an account alias", async () => {
    registerPlugin({
        id: "fixture-sub",
        kind: "subscription",
        capabilities: new Set(),
        credential: { fields: [], envKeys: [] },
        async bind() {
            throw new Error("History discovery must not bind credentials");
        },
        codingAgent: {
            kind: "fixture",
            parserVersion: "1",
            roots: () => [],
            async discover() {
                return { sources: [], issues: [], completeRoots: [] };
            },
            async read(source) {
                return {
                    session: {
                        kind: "fixture",
                        sessionId: "native-one",
                        title: "Invented conversation",
                        cwd: "/invented/project",
                        mtime: new Date("2026-08-15T12:00:00.000Z"),
                        filePath: source.filePath,
                    },
                    entries: [],
                    issues: [],
                };
            },
        },
    });
    const provider = resolveHistoryProvider("fixture-sub");
    const transcript = await provider.reader.read({
        kind: "fixture",
        root: "/invented/history",
        sourceHome: "/invented",
        filePath: "/invented/history/native-one",
        dataPaths: [],
        metadataPaths: [],
    });

    expect(provider.id).toBe("fixture-sub");
    expect(transcript.session.sessionId).toBe("native-one");
    expect(transcript.session.kind).toBe("fixture");
    expect(() => resolveHistoryProvider("missing-provider")).toThrow("Unknown AI provider");
});

test("session queue inspections are read-only and exact provider/session/home scope survives restart", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "session-queue-"));
    const root = join(scratch, "queue");
    const target = { provider: "codex" as const, sessionId: "fixture-thread", sourceHome: "/fixture/home" };
    expect(listSessionMessages({ target, root })).toEqual([]);
    expect(existsSync(root)).toBe(false);
    const queued = await enqueueSessionMessage({
        target,
        root,
        text: "Synthetic answer with durable media paths",
        idempotencyKey: "outgoing-one",
    });
    expect(queued.state).toBe("queued");
    expect(await enqueueSessionMessage({ target, root, text: queued.text, idempotencyKey: "outgoing-one" })).toEqual(
        queued
    );
    await expect(
        enqueueSessionMessage({ target, root, text: "different revision", idempotencyKey: "outgoing-one" })
    ).rejects.toThrow("different text");
    expect(listSessionMessages({ target, root })).toEqual([queued]);
    for (const other of [
        { ...target, provider: "claude" as const },
        { ...target, sessionId: "other-thread" },
        { ...target, sourceHome: "/other/home" },
    ]) {
        expect(listSessionMessages({ target: other, root })).toEqual([]);
        await expect(
            acknowledgeSessionMessage({ target: other, root, id: queued.id, consumer: "fixture-reader" })
        ).rejects.toThrow("not found");
    }
    expect(listSessionMessages({ target, root })[0].state).toBe("queued");
});

test("session queue offers are exclusive and only their consumer can acknowledge, never silently retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-queue-owner-"));
    const target = { provider: "grok" as const, sessionId: "fixture-session", sourceHome: "/fixture/grok" };
    const message = await enqueueSessionMessage({ root, target, text: "Synthetic follow-up" });
    await expect(acknowledgeSessionMessage({ root, target, id: message.id, consumer: "first" })).rejects.toThrow(
        "holding"
    );
    const offers = await Promise.allSettled(
        ["first", "second"].map((consumer) => offerSessionMessage({ root, target, id: message.id, consumer }))
    );
    expect(offers.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const offered = listSessionMessages({ root, target })[0];
    expect(offered.state).toBe("offered");
    await expect(cancelSessionMessage({ root, target, id: message.id })).rejects.toThrow("may already have reached");
    await expect(acknowledgeSessionMessage({ root, target, id: message.id, consumer: "wrong" })).rejects.toThrow(
        "holding"
    );
    const received = await acknowledgeSessionMessage({ root, target, id: message.id, consumer: offered.consumer! });
    expect(received.state).toBe("received");
    expect(await acknowledgeSessionMessage({ root, target, id: message.id, consumer: offered.consumer! })).toEqual(
        received
    );
    await expect(offerSessionMessage({ root, target, id: message.id, consumer: offered.consumer! })).rejects.toThrow(
        "already"
    );
    const pending = await enqueueSessionMessage({ root, target, text: "Can cancel this unsent message" });
    expect((await cancelSessionMessage({ root, target, id: pending.id })).state).toBe("cancelled");
    await expect(offerSessionMessage({ root, target, id: pending.id, consumer: "first" })).rejects.toThrow("cancelled");
});
