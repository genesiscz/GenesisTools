import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportedMessageCount } from "@app/ms-teams/commands/show";
import { SafeJSON } from "@genesiscz/utils/json";
import { renderMarkdown } from "./export/markdown";
import { exportThread } from "./export/thread";
import { parseShowQuery } from "./query";
import { resolveConversation } from "./resolve-chat";
import { TeamsCache } from "./store";
import type { TeamsDump } from "./types";

const ADA_ID = "19:ada-guid_me-guid@unq.gbl.spaces";
const MEETING_ID = "19:meeting_planning@thread.v2";
const ADA_AUG6 = Date.parse("2026-08-06T06:24:04Z");
const ADA_JUN8 = Date.parse("2026-06-08T09:00:00Z");

function sampleDump(): TeamsDump {
    return {
        profiles: [
            {
                mri: "8:orgid:ada",
                displayName: "Ada Lovelace",
                email: "ada@example.test",
                objectId: "ada",
            },
        ],
        conversations: [
            {
                id: ADA_ID,
                type: "Chat",
                chatTitle: {
                    shortTitle: "Ada Lovelace",
                    avatarUsersInfo: [{ mri: "8:orgid:ada", displayName: "Ada Lovelace", email: "ada@example.test" }],
                },
                threadProperties: {},
                members: [{ id: "8:orgid:ada" }, { id: "8:orgid:me" }],
                lastMessage: { content: "<p>hello, I will look at it today</p>" },
                lastMessageTimeUtc: ADA_AUG6,
            },
            {
                id: MEETING_ID,
                type: "Meeting",
                chatTitle: { shortTitle: "Planning" },
                threadProperties: { topic: "Planning" },
                members: [{ id: "8:orgid:ada", friendlyName: "Ada Lovelace" }],
                lastMessage: { content: "<p>agenda</p>" },
                lastMessageTimeUtc: ADA_AUG6,
            },
        ],
        replychains: [
            {
                conversationId: ADA_ID,
                messageMap: {
                    a1: {
                        id: "m-jun",
                        conversationId: ADA_ID,
                        originalArrivalTime: ADA_JUN8,
                        version: ADA_JUN8,
                        creator: "8:orgid:ada",
                        imDisplayName: "Ada Lovelace",
                        messageType: "RichText/Html",
                        content: "<p>hello, I will look at it today (june)</p>",
                        isSentByCurrentUser: false,
                        properties: {},
                    },
                    a2: {
                        id: "m-aug",
                        conversationId: ADA_ID,
                        originalArrivalTime: ADA_AUG6,
                        version: ADA_AUG6,
                        creator: "8:orgid:ada",
                        imDisplayName: "Ada Lovelace",
                        messageType: "RichText/Html",
                        content: "<p>hello, I will look at it today</p>",
                        isSentByCurrentUser: false,
                        properties: {
                            files: SafeFiles(),
                        },
                        annotationsSummary: { emotions: { laugh: 1 } },
                    },
                    a3: {
                        id: "m-reply",
                        conversationId: ADA_ID,
                        originalArrivalTime: ADA_AUG6 + 1000,
                        version: ADA_AUG6 + 1000,
                        creator: "8:orgid:me",
                        imDisplayName: "Me",
                        messageType: "RichText/Html",
                        content:
                            '<blockquote itemtype="http://schema.skype.com/Reply" itemid="m-aug"><p>hello</p></blockquote><p>thanks</p>',
                        isSentByCurrentUser: true,
                        parentMessageId: "m-reply",
                        properties: {},
                    },
                },
            },
            {
                conversationId: MEETING_ID,
                messageMap: {
                    p1: {
                        id: "meet-1",
                        conversationId: MEETING_ID,
                        originalArrivalTime: ADA_AUG6,
                        version: ADA_AUG6,
                        creator: "8:orgid:ada",
                        imDisplayName: "Ada Lovelace",
                        messageType: "RichText/Html",
                        content: "<p>agenda item</p>",
                        parentMessageId: "meet-1",
                        properties: {},
                    },
                },
            },
        ],
        calls: [],
        activity: [],
    };
}

function SafeFiles(): string {
    return SafeJSON.stringify([
        {
            fileName: "shot.png",
            fileType: "png",
            objectUrl: "https://example.test/shot.png",
            itemid: "item-1",
        },
    ]);
}

describe("TeamsCache ingest and query", () => {
    test("resolves a 1:1 by person name and filters by day", () => {
        const cache = new TeamsCache(":memory:");
        cache.ingestDump(sampleDump());
        const resolved = resolveConversation(cache, parseShowQuery("conversation with Ada Lovelace"));
        expect(resolved.status).toBe("exact");

        if (resolved.status !== "exact") {
            return;
        }

        expect(resolved.conversation.id).toBe(ADA_ID);
        const query = parseShowQuery("conversation with Ada Lovelace from 2026-08-06 to 2026-08-06");
        const thread = exportThread(cache, resolved.conversation.id, { from: query.from, to: query.to });
        expect(thread.messages.some((m) => m.text.includes("hello, I will look at it today"))).toBe(true);
        expect(thread.messages.some((m) => m.text.includes("june"))).toBe(false);
        expect(thread.messages.some((m) => m.replyToId === "m-aug")).toBe(true);
        const md = renderMarkdown(thread);
        expect(md).toContain("Ada Lovelace");
        expect(md).toContain("hello, I will look at it today");
        expect(md).toContain("shot.png");
        cache.close();
    });

    test("search finds text inside the 1:1", () => {
        const cache = new TeamsCache(":memory:");
        cache.ingestDump(sampleDump());
        const hits = cache.searchMessages("look at it today", { withName: "Ada Lovelace" });
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.some((h) => h.conversationId === ADA_ID)).toBe(true);
        cache.close();
    });

    test("resolves a meeting by topic", () => {
        const cache = new TeamsCache(":memory:");
        cache.ingestDump(sampleDump());
        const resolved = resolveConversation(cache, parseShowQuery("Planning"));
        expect(resolved.status).toBe("exact");

        if (resolved.status === "exact") {
            expect(resolved.conversation.id).toBe(MEETING_ID);
        }

        cache.close();
    });

    test("refuses to wipe a populated cache with an empty dump", () => {
        const cache = new TeamsCache(":memory:");
        cache.ingestDump(sampleDump());
        expect(() =>
            cache.ingestDump({ conversations: [], replychains: [], profiles: [], calls: [], activity: [] })
        ).toThrow(/empty/);
        expect(cache.counts().conversations).toBeGreaterThan(0);
        cache.close();
    });
});

function adaMessage(opts: { id: string; at: number; version?: number; content: string; deletetime?: number }) {
    return {
        id: opts.id,
        conversationId: ADA_ID,
        originalArrivalTime: opts.at,
        version: opts.version ?? opts.at,
        creator: "8:orgid:ada",
        imDisplayName: "Ada Lovelace",
        messageType: "RichText/Html",
        content: opts.content,
        properties: opts.deletetime ? { deletetime: opts.deletetime } : {},
    };
}

function dumpWith(messages: Record<string, unknown>): TeamsDump {
    const base = sampleDump();
    return { ...base, replychains: [{ conversationId: ADA_ID, messageMap: messages }] };
}

describe("TeamsCache retained history", () => {
    test("keeps a message the next snapshot no longer contains", () => {
        const cache = new TeamsCache(":memory:");
        cache.ingestDump(sampleDump());
        cache.ingestDump(
            dumpWith({
                a2: adaMessage({ id: "m-aug", at: ADA_AUG6, content: "<p>hello, I will look at it today</p>" }),
            })
        );

        const thread = exportThread(cache, ADA_ID);
        expect(thread.messages.map((m) => m.id)).toEqual(["m-jun", "m-aug", "m-reply"]);
        expect(thread.conversation.retainedCount).toBe(2);
        expect(renderMarkdown(thread)).toContain("3 messages (2 kept from earlier syncs)");
        expect(cache.searchMessages("june", {}).map((m) => m.id)).toEqual(["m-jun"]);
        cache.close();
    });

    test("an edited message updates in place and an older version never wins", () => {
        const cache = new TeamsCache(":memory:");
        cache.ingestDump(sampleDump());
        const edited = adaMessage({
            id: "m-jun",
            at: ADA_JUN8,
            version: ADA_JUN8 + 5000,
            content: "<p>edited text</p>",
        });
        cache.ingestDump(dumpWith({ a1: edited }));
        cache.ingestDump(dumpWith({ a1: adaMessage({ id: "m-jun", at: ADA_JUN8, content: "<p>stale text</p>" }) }));

        const rows = cache.listMessages(ADA_ID).filter((m) => m.id === "m-jun");
        expect(rows).toHaveLength(1);
        expect(rows[0]?.text).toBe("edited text");
        expect(cache.searchMessages("stale", {})).toHaveLength(0);
        expect(cache.searchMessages("edited", {}).map((m) => m.id)).toEqual(["m-jun"]);
        cache.close();
    });

    test("a --force ingest keeps retained history", () => {
        const cache = new TeamsCache(":memory:");
        cache.ingestDump(sampleDump());
        cache.ingestDump(dumpWith({}), { force: true });
        cache.ingestDump(
            { conversations: [], replychains: [], profiles: [], calls: [], activity: [] },
            { force: true }
        );

        expect(cache.listMessages(ADA_ID)).toHaveLength(3);
        expect(cache.getConversation(MEETING_ID)).not.toBeNull();
        cache.close();
    });

    test("a message deleted in Teams keeps its last text and is marked", () => {
        const cache = new TeamsCache(":memory:");
        cache.ingestDump(sampleDump());
        const deletedAt = ADA_JUN8 + 9000;
        cache.ingestDump(
            dumpWith({
                a1: adaMessage({ id: "m-jun", at: ADA_JUN8, version: deletedAt, content: "", deletetime: deletedAt }),
            })
        );

        const thread = exportThread(cache, ADA_ID);
        const jun = thread.messages.find((m) => m.id === "m-jun");
        expect(jun?.text).toContain("june");
        expect(jun?.deletedAt).toBe(new Date(deletedAt).toISOString());
        expect(renderMarkdown(thread)).toContain("_(deleted in Teams)_");
        cache.close();
    });

    test("the same message id in two conversations is stored twice", () => {
        const cache = new TeamsCache(":memory:");
        const dump = sampleDump();
        dump.replychains.push({
            conversationId: MEETING_ID,
            messageMap: {
                x: {
                    ...adaMessage({ id: "m-jun", at: ADA_JUN8, content: "<p>meeting copy</p>" }),
                    conversationId: MEETING_ID,
                },
            },
        });
        cache.ingestDump(dump);

        expect(cache.listMessages(ADA_ID).some((m) => m.id === "m-jun")).toBe(true);
        expect(cache.listMessages(MEETING_ID).some((m) => m.id === "m-jun")).toBe(true);
        cache.close();
    });

    test("migrates a store from before retention without losing rows or search", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ms-teams-store-"));

        try {
            const path = join(dir, "cache.db");
            const legacy = new Database(path);
            legacy.run(`CREATE TABLE messages (
                id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sequence_id INTEGER, version INTEGER,
                original_arrival_time INTEGER NOT NULL, from_mri TEXT, from_name TEXT, is_from_me INTEGER NOT NULL DEFAULT 0,
                message_type TEXT NOT NULL, text TEXT, html TEXT, reply_to_id TEXT,
                reactions_json TEXT NOT NULL DEFAULT '[]', mentions_json TEXT NOT NULL DEFAULT '[]',
                links_json TEXT NOT NULL DEFAULT '[]', attachments_json TEXT NOT NULL DEFAULT '[]')`);
            legacy.run(
                `CREATE VIRTUAL TABLE messages_fts USING fts5(text, content=messages, content_rowid=rowid, tokenize='unicode61')`
            );
            legacy.run(`CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text); END`);
            legacy.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
            legacy.run(`INSERT INTO meta (key, value) VALUES ('ingested_at', '2026-09-22T10:00:00.000Z')`);
            legacy.run(
                `INSERT INTO messages (id, conversation_id, version, original_arrival_time, message_type, text)
                 VALUES ('old-1', ?, 1, ?, 'RichText/Html', 'legacy retained words')`,
                [ADA_ID, ADA_JUN8]
            );
            legacy.close();

            const cache = new TeamsCache(path);
            cache.ingestDump(sampleDump());
            const ids = cache.listMessages(ADA_ID).map((m) => m.id);
            expect(ids).toContain("old-1");
            expect(ids).toHaveLength(4);
            expect(cache.searchMessages("legacy retained", {}).map((m) => m.id)).toEqual(["old-1"]);
            expect(exportThread(cache, ADA_ID).conversation.retainedCount).toBe(1);
            cache.close();

            const md = join(dir, "thread.md");
            writeFileSync(md, "# Ada\n\nchat · 229 messages · cached a → b\n");
            expect(await exportedMessageCount(md)).toBe(229);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
