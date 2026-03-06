import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramHistoryStore } from "../TelegramHistoryStore";

function tmpDbPath() {
    return join(tmpdir(), `telegram-seg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("Sync segment tracking", () => {
    let store: TelegramHistoryStore;
    let dbPath: string;

    beforeEach(() => {
        dbPath = tmpDbPath();
        store = new TelegramHistoryStore();
        store.open(dbPath);
    });

    afterEach(() => {
        store.close();

        if (existsSync(dbPath)) {
            unlinkSync(dbPath);
        }
    });

    it("inserts a sync segment", () => {
        store.insertSyncSegment("chat1", {
            fromDateUnix: 1700000000,
            toDateUnix: 1700086400,
            fromMsgId: 1,
            toMsgId: 100,
        });

        const segments = store.getSyncSegments("chat1");
        expect(segments.length).toBe(1);
        expect(segments[0].from_msg_id).toBe(1);
        expect(segments[0].to_msg_id).toBe(100);
    });

    it("detects missing segments (gap in coverage)", () => {
        store.insertSyncSegment("chat1", {
            fromDateUnix: 1700000000,
            toDateUnix: 1700086400,
            fromMsgId: 1,
            toMsgId: 50,
        });
        store.insertSyncSegment("chat1", {
            fromDateUnix: 1700172800,
            toDateUnix: 1700259200,
            fromMsgId: 100,
            toMsgId: 150,
        });

        const gaps = store.getMissingSegments("chat1", 1700000000, 1700259200);
        expect(gaps.length).toBe(1);
        expect(gaps[0].fromDateUnix).toBe(1700086400);
        expect(gaps[0].toDateUnix).toBe(1700172800);
    });

    it("returns empty when fully covered", () => {
        store.insertSyncSegment("chat1", {
            fromDateUnix: 1700000000,
            toDateUnix: 1700259200,
            fromMsgId: 1,
            toMsgId: 150,
        });

        const gaps = store.getMissingSegments("chat1", 1700000000, 1700259200);
        expect(gaps.length).toBe(0);
    });

    it("returns full range when no segments exist", () => {
        const gaps = store.getMissingSegments("chat1", 1700000000, 1700259200);
        expect(gaps.length).toBe(1);
        expect(gaps[0].fromDateUnix).toBe(1700000000);
        expect(gaps[0].toDateUnix).toBe(1700259200);
    });
});
