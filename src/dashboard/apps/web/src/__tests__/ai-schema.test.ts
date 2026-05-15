import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const aiConversations = sqliteTable(
    "ai_conversations",
    {
        id: text("id").primaryKey(),
        userId: text("user_id").notNull(),
        title: text("title").notNull(),
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull(),
    },
    (t) => ({ userIdx: index("idx_ai_conv_user_id").on(t.userId) })
);

const aiMessages = sqliteTable(
    "ai_messages",
    {
        id: text("id").primaryKey(),
        conversationId: text("conversation_id").notNull(),
        role: text("role").notNull().$type<"user" | "assistant" | "system">(),
        content: text("content").notNull(),
        createdAt: text("created_at").notNull(),
    },
    (t) => ({
        convIdx: index("idx_ai_msg_conv_id").on(t.conversationId),
    })
);

let testDb: ReturnType<typeof drizzle>;
let sqlite: InstanceType<typeof Database>;

beforeAll(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
        CREATE TABLE ai_conversations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_ai_conv_user_id ON ai_conversations(user_id);
        CREATE TABLE ai_messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX idx_ai_msg_conv_id ON ai_messages(conversation_id);
    `);
    testDb = drizzle(sqlite, { schema: { aiConversations, aiMessages } });
});

afterAll(() => {
    sqlite.close();
});

describe("ai_conversations schema", () => {
    test("insert and retrieve a conversation", () => {
        const now = new Date().toISOString();
        testDb
            .insert(aiConversations)
            .values({
                id: "conv-1",
                userId: "user-test",
                title: "Hello World",
                createdAt: now,
                updatedAt: now,
            })
            .run();

        const row = testDb.select().from(aiConversations).where(eq(aiConversations.id, "conv-1")).get();
        expect(row?.title).toBe("Hello World");
        expect(row?.userId).toBe("user-test");
    });
});

describe("ai_messages schema", () => {
    test("insert and retrieve messages by conversationId", () => {
        const now = new Date().toISOString();
        testDb
            .insert(aiMessages)
            .values([
                { id: "msg-1", conversationId: "conv-1", role: "user", content: "Hi", createdAt: now },
                { id: "msg-2", conversationId: "conv-1", role: "assistant", content: "Hello!", createdAt: now },
            ])
            .run();

        const rows = testDb.select().from(aiMessages).where(eq(aiMessages.conversationId, "conv-1")).all();
        expect(rows).toHaveLength(2);
        expect(rows[0].role).toBe("user");
        expect(rows[1].role).toBe("assistant");
    });
});
