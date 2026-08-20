import { describe, expect, test } from "bun:test";
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
