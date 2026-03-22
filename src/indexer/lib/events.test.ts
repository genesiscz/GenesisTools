import { describe, expect, it } from "bun:test";
import type { IndexerCallbacks, IndexerEventMap } from "./events";
import { IndexerEventEmitter } from "./events";

describe("IndexerEventEmitter", () => {
    it("fires exact event handler with correct payload", () => {
        const emitter = new IndexerEventEmitter();
        let received: IndexerEventMap["scan:start"] | null = null;

        emitter.on("scan:start", (payload) => {
            received = payload;
        });

        emitter.emit("scan:start", { indexName: "test", strategy: "git" });

        expect(received).not.toBeNull();
        expect(received!.indexName).toBe("test");
        expect(received!.strategy).toBe("git");
    });

    it("auto-injects ts as a number", () => {
        const emitter = new IndexerEventEmitter();
        let received: IndexerEventMap["scan:start"] | null = null;

        emitter.on("scan:start", (payload) => {
            received = payload;
        });

        const before = Date.now();
        emitter.emit("scan:start", { indexName: "test", strategy: "git" });
        const after = Date.now();

        expect(received).not.toBeNull();
        expect(typeof received!.ts).toBe("number");
        expect(received!.ts).toBeGreaterThanOrEqual(before);
        expect(received!.ts).toBeLessThanOrEqual(after);
    });

    it("fires namespace wildcard handler for all events in namespace", () => {
        const emitter = new IndexerEventEmitter();
        const received: string[] = [];

        emitter.on("embed:*", (payload) => {
            received.push(payload.event);
        });

        emitter.emit("embed:start", {
            indexName: "test",
            totalChunks: 10,
            provider: "darwinkit",
            dimensions: 384,
        });
        emitter.emit("embed:progress", {
            indexName: "test",
            completed: 5,
            total: 10,
            currentFile: "a.ts",
        });
        emitter.emit("embed:complete", {
            indexName: "test",
            embedded: 10,
            skipped: 0,
            durationMs: 100,
        });

        expect(received).toEqual(["embed:start", "embed:progress", "embed:complete"]);
    });

    it("does not fire namespace wildcard for other namespaces", () => {
        const emitter = new IndexerEventEmitter();
        let called = false;

        emitter.on("embed:*", () => {
            called = true;
        });

        emitter.emit("scan:start", { indexName: "test", strategy: "git" });

        expect(called).toBe(false);
    });

    it("fires global wildcard handler for everything", () => {
        const emitter = new IndexerEventEmitter();
        const received: string[] = [];

        emitter.on("*", (payload) => {
            received.push(payload.event);
        });

        emitter.emit("scan:start", { indexName: "test", strategy: "git" });
        emitter.emit("embed:start", {
            indexName: "test",
            totalChunks: 5,
            provider: "local",
            dimensions: 768,
        });
        emitter.emit("watch:stop", { indexName: "test" });

        expect(received).toEqual(["scan:start", "embed:start", "watch:stop"]);
    });

    it("removes handler with off()", () => {
        const emitter = new IndexerEventEmitter();
        let callCount = 0;

        const handler = () => {
            callCount++;
        };

        emitter.on("scan:start", handler);
        emitter.emit("scan:start", { indexName: "test", strategy: "git" });
        expect(callCount).toBe(1);

        emitter.off("scan:start", handler);
        emitter.emit("scan:start", { indexName: "test", strategy: "git" });
        expect(callCount).toBe(1);
    });

    it("wildcard payload includes event discriminant field", () => {
        const emitter = new IndexerEventEmitter();
        let receivedEvent: string | undefined;

        emitter.on("sync:*", (payload) => {
            receivedEvent = payload.event;
        });

        emitter.emit("sync:start", { indexName: "test", mode: "incremental" });

        expect(receivedEvent).toBe("sync:start");
    });

    it("dispatches inline callbacks", () => {
        const emitter = new IndexerEventEmitter();
        let callbackPayload: IndexerEventMap["scan:start"] | null = null;

        const callbacks: IndexerCallbacks = {
            onScanStart: (payload) => {
                callbackPayload = payload;
            },
        };

        emitter.emit("scan:start", { indexName: "test", strategy: "merkle" });

        const fullPayload: IndexerEventMap["scan:start"] = {
            ts: Date.now(),
            indexName: "test",
            strategy: "merkle",
        };
        emitter.dispatchCallbacks("scan:start", fullPayload, callbacks);

        expect(callbackPayload).not.toBeNull();
        expect(callbackPayload!.indexName).toBe("test");
        expect(callbackPayload!.strategy).toBe("merkle");
    });

    it("handles multiple handlers for the same event", () => {
        const emitter = new IndexerEventEmitter();
        let count = 0;

        emitter.on("scan:start", () => {
            count++;
        });
        emitter.on("scan:start", () => {
            count++;
        });

        emitter.emit("scan:start", { indexName: "test", strategy: "git" });

        expect(count).toBe(2);
    });

    it("IndexerCallbacks has expected keys", () => {
        const callbacks: IndexerCallbacks = {
            onScanStart: () => {},
            onScanComplete: () => {},
            onChunkFile: () => {},
            onChunkSkip: () => {},
            onEmbedStart: () => {},
            onEmbedProgress: () => {},
            onEmbedComplete: () => {},
            onSyncStart: () => {},
            onSyncComplete: () => {},
            onSyncError: () => {},
            onWatchStart: () => {},
            onWatchChange: () => {},
            onWatchStop: () => {},
            onSearchQuery: () => {},
        };

        expect(callbacks).toBeDefined();
    });
});
