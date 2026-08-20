import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { foldTeamsText } from "./decode";
import {
    isSystemMessageType,
    type ParsedConversation,
    type ParsedMessage,
    parseConversation,
    parseProfile,
    parseReplychain,
} from "./ingest-parse";
import type {
    ActivityRow,
    CallRow,
    ConversationRow,
    ConversationType,
    ListConversationsOptions,
    ListMessagesOptions,
    MessageRow,
    PeopleRow,
    Person,
    TeamsDump,
} from "./types";

const log = logger.scoped("ms-teams").log;

export class TeamsCache {
    private db: Database;

    constructor(dbPath: string, opts?: { readonly?: boolean }) {
        if (dbPath !== ":memory:") {
            mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
        }

        if (opts?.readonly) {
            this.db = new Database(dbPath, { readonly: true });
            return;
        }

        this.db = new Database(dbPath);
        this.db.run("PRAGMA journal_mode = WAL");
        this.db.run("PRAGMA foreign_keys = ON");
        this.migrate();

        if (dbPath !== ":memory:") {
            chmodSync(dbPath, 0o600);
        }
    }

    close(): void {
        this.db.close();
    }

    private migrate(): void {
        this.db.run(`CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            topic TEXT,
            members_json TEXT NOT NULL,
            last_message_time INTEGER,
            last_preview TEXT,
            member_count INTEGER NOT NULL DEFAULT 0
        )`);
        this.db.run(`CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            sequence_id INTEGER,
            version INTEGER,
            original_arrival_time INTEGER NOT NULL,
            from_mri TEXT,
            from_name TEXT,
            is_from_me INTEGER NOT NULL DEFAULT 0,
            message_type TEXT NOT NULL,
            text TEXT,
            html TEXT,
            reply_to_id TEXT,
            reactions_json TEXT NOT NULL DEFAULT '[]',
            mentions_json TEXT NOT NULL DEFAULT '[]',
            links_json TEXT NOT NULL DEFAULT '[]',
            attachments_json TEXT NOT NULL DEFAULT '[]'
        )`);
        this.db.run(
            `CREATE INDEX IF NOT EXISTS idx_messages_conv_time ON messages(conversation_id, original_arrival_time)`
        );
        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            text, content=messages, content_rowid=rowid, tokenize='unicode61'
        )`);
        try {
            this.db.run(`CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
            END`);
            this.db.run(`CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
            END`);
            this.db.run(`CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
                INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
            END`);
        } catch (err) {
            log.debug({ err }, "[ms-teams] fts triggers already exist");
        }
        this.db.run(`CREATE TABLE IF NOT EXISTS people (
            mri TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            email TEXT,
            upn TEXT
        )`);
        this.db.run(`CREATE TABLE IF NOT EXISTS calls (
            id TEXT PRIMARY KEY,
            start_time TEXT,
            end_time TEXT,
            call_type TEXT,
            call_state TEXT,
            call_direction TEXT,
            thread_id TEXT,
            summary TEXT NOT NULL DEFAULT ''
        )`);
        this.db.run(`CREATE TABLE IF NOT EXISTS activity (
            id TEXT PRIMARY KEY,
            activity_type TEXT NOT NULL,
            activity_subtype TEXT,
            source_thread_id TEXT,
            source_message_id TEXT,
            timestamp INTEGER
        )`);
        this.db.run(`CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`);
    }

    ingestDump(
        dump: TeamsDump,
        opts?: { force?: boolean }
    ): { conversations: number; messages: number; people: number } {
        if (!opts?.force && dump.conversations.length === 0 && dump.replychains.length === 0) {
            throw new Error("Teams dump is empty; refusing to wipe the cache. Pass --force to override.");
        }

        const people = new Map<string, Person>();
        let meMri: string | null = this.getMeta("me_mri");

        for (const raw of dump.profiles) {
            const person = parseProfile(raw);

            if (person) {
                people.set(person.mri, person);
            }
        }

        const conversations = new Map<string, ParsedConversation>();

        for (const raw of dump.conversations) {
            const parsed = parseConversation(raw);

            if (parsed) {
                conversations.set(parsed.id, parsed);

                for (const member of parsed.members) {
                    if (!people.has(member.mri)) {
                        people.set(member.mri, member);
                    }
                }
            }
        }

        const messages = new Map<string, ParsedMessage>();

        for (const raw of dump.replychains) {
            for (const parsed of parseReplychain(raw, meMri)) {
                const prev = messages.get(parsed.id);

                if (!prev || parsed.version >= prev.version) {
                    messages.set(parsed.id, parsed);
                }

                if (parsed.isFromMe && parsed.fromMri) {
                    meMri = parsed.fromMri;
                }

                if (parsed.fromMri && parsed.fromName && !people.has(parsed.fromMri)) {
                    people.set(parsed.fromMri, {
                        mri: parsed.fromMri,
                        displayName: parsed.fromName,
                        email: null,
                    });
                }
            }
        }

        if (meMri) {
            for (const msg of messages.values()) {
                if (!msg.isFromMe && msg.fromMri === meMri) {
                    msg.isFromMe = true;
                }
            }
        }

        const tx = this.db.transaction(() => {
            this.db.run("DELETE FROM conversations");
            this.db.run("DELETE FROM messages");
            this.db.run("DELETE FROM people");
            this.db.run("DELETE FROM calls");
            this.db.run("DELETE FROM activity");

            const insertConv = this.db.prepare(
                `INSERT INTO conversations (id, type, title, topic, members_json, last_message_time, last_preview, member_count)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const insertMsg = this.db.prepare(
                `INSERT INTO messages (id, conversation_id, sequence_id, version, original_arrival_time, from_mri, from_name, is_from_me, message_type, text, html, reply_to_id, reactions_json, mentions_json, links_json, attachments_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const insertPerson = this.db.prepare(
                `INSERT OR REPLACE INTO people (mri, display_name, email, upn) VALUES (?, ?, ?, ?)`
            );

            for (const conv of conversations.values()) {
                insertConv.run(
                    conv.id,
                    conv.type,
                    conv.title,
                    conv.topic,
                    SafeJSON.stringify(conv.members),
                    conv.lastMessageTime,
                    conv.lastPreview,
                    conv.members.length
                );
            }

            for (const msg of messages.values()) {
                insertMsg.run(
                    msg.id,
                    msg.conversationId,
                    msg.sequenceId,
                    msg.version,
                    msg.originalArrivalTime,
                    msg.fromMri,
                    msg.fromName,
                    msg.isFromMe ? 1 : 0,
                    msg.messageType,
                    msg.text,
                    msg.html,
                    msg.replyToId,
                    SafeJSON.stringify(msg.reactions),
                    SafeJSON.stringify(msg.mentions),
                    SafeJSON.stringify(msg.links),
                    SafeJSON.stringify(msg.attachments)
                );
            }

            for (const person of people.values()) {
                insertPerson.run(person.mri, person.displayName, person.email, person.email);
            }

            this.ingestCalls(dump.calls);
            this.ingestActivity(dump.activity);
        });

        tx();

        if (meMri) {
            this.setMeta("me_mri", meMri);
        }

        this.setMeta("ingested_at", new Date().toISOString());
        log.debug(
            { conversations: conversations.size, messages: messages.size, people: people.size },
            "[ms-teams] ingest complete"
        );

        return { conversations: conversations.size, messages: messages.size, people: people.size };
    }

    private ingestCalls(rows: unknown[]): void {
        const insert = this.db.prepare(
            `INSERT OR REPLACE INTO calls (id, start_time, end_time, call_type, call_state, call_direction, thread_id, summary)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );

        for (const raw of rows) {
            if (!raw || typeof raw !== "object") {
                continue;
            }

            const rec = raw as Record<string, unknown>;
            const id = String(rec.id ?? "");

            if (!id) {
                continue;
            }

            insert.run(
                id,
                rec.startTime ? String(rec.startTime) : null,
                rec.endTime ? String(rec.endTime) : null,
                rec.callType ? String(rec.callType) : null,
                rec.callState ? String(rec.callState) : null,
                rec.callDirection ? String(rec.callDirection) : null,
                rec.groupChatThreadId ? String(rec.groupChatThreadId) : null,
                SafeJSON.stringify(rec)
            );
        }
    }

    private ingestActivity(rows: unknown[]): void {
        const insert = this.db.prepare(
            `INSERT OR REPLACE INTO activity (id, activity_type, activity_subtype, source_thread_id, source_message_id, timestamp)
             VALUES (?, ?, ?, ?, ?, ?)`
        );

        for (const raw of rows) {
            if (!raw || typeof raw !== "object") {
                continue;
            }

            const rec = raw as Record<string, unknown>;
            const id = String(rec.activityId ?? rec.id ?? "");

            if (!id) {
                continue;
            }

            const ts = typeof rec.timestamp === "number" ? rec.timestamp : Number(rec.timestamp) || null;
            insert.run(
                id,
                String(rec.activityType ?? ""),
                rec.activitySubtype ? String(rec.activitySubtype) : null,
                rec.sourceThreadId ? String(rec.sourceThreadId) : null,
                rec.sourceMessageId ? String(rec.sourceMessageId) : null,
                ts
            );
        }
    }

    setMeta(key: string, value: string): void {
        this.db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [key, value]);
    }

    getMeta(key: string): string | null {
        const row = this.db.query(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | null;
        return row?.value ?? null;
    }

    counts(): { conversations: number; messages: number; people: number; calls: number; activity: number } {
        const one = (table: string) => {
            const row = this.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
            return row.n;
        };

        return {
            conversations: one("conversations"),
            messages: one("messages"),
            people: one("people"),
            calls: one("calls"),
            activity: one("activity"),
        };
    }

    listConversations(opts: ListConversationsOptions = {}): ConversationRow[] {
        const rows = this.db.query(`SELECT * FROM conversations ORDER BY last_message_time DESC`).all() as Array<{
            id: string;
            type: ConversationType;
            title: string;
            topic: string | null;
            members_json: string;
            last_message_time: number | null;
            last_preview: string | null;
            member_count: number;
        }>;
        const foldedWith = opts.withName ? foldTeamsText(opts.withName) : "";
        const foldedTopic = opts.topic ? foldTeamsText(opts.topic) : "";
        const fromMs = opts.from?.getTime();
        const toMs = opts.to?.getTime();
        const out: ConversationRow[] = [];

        for (const row of rows) {
            if (opts.type && opts.type !== "group" && row.type !== opts.type) {
                continue;
            }

            if (opts.type === "group" && (row.type === "meeting" || isOneToOneId(row.id, row.title))) {
                continue;
            }

            if (fromMs !== undefined && (row.last_message_time ?? 0) < fromMs) {
                continue;
            }

            if (toMs !== undefined && (row.last_message_time ?? 0) > toMs) {
                continue;
            }

            const hay = `${foldTeamsText(row.title)} ${foldTeamsText(row.topic)} ${foldTeamsText(row.members_json)}`;

            if (foldedWith && !hay.includes(foldedWith)) {
                continue;
            }

            if (foldedTopic && !hay.includes(foldedTopic)) {
                continue;
            }

            out.push(mapConversationRow(row));

            if (opts.limit && out.length >= opts.limit) {
                break;
            }
        }

        return out;
    }

    getConversation(id: string): ConversationRow | null {
        const row = this.db.query(`SELECT * FROM conversations WHERE id = ?`).get(id) as {
            id: string;
            type: ConversationType;
            title: string;
            topic: string | null;
            members_json: string;
            last_message_time: number | null;
            last_preview: string | null;
            member_count: number;
        } | null;

        return row ? mapConversationRow(row) : null;
    }

    listMessages(conversationId: string, opts: ListMessagesOptions = {}): MessageRow[] {
        const fromMs = opts.from?.getTime() ?? 0;
        const toMs = opts.to?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const rows = this.db
            .query(
                `SELECT * FROM messages WHERE conversation_id = ? AND original_arrival_time >= ? AND original_arrival_time <= ?
                 ORDER BY original_arrival_time ASC, sequence_id ASC`
            )
            .all(conversationId, fromMs, toMs) as Array<Record<string, unknown>>;
        const mapped = rows.map(mapMessageRow);

        if (opts.includeSystem === false) {
            return mapped.filter((m) => !isSystemMessageType(m.messageType));
        }

        return mapped;
    }

    searchMessages(
        text: string,
        opts: { withName?: string; conversationId?: string; from?: Date; to?: Date; limit?: number }
    ): MessageRow[] {
        const requested = opts.limit ?? 50;
        const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 500) : 50;
        const rows = this.db
            .query(
                `SELECT m.* FROM messages_fts f
                 JOIN messages m ON m.rowid = f.rowid
                 WHERE messages_fts MATCH ?
                 ORDER BY m.original_arrival_time DESC
                 LIMIT ?`
            )
            .all(escapeFts(text), limit * 4) as Array<Record<string, unknown>>;
        const fromMs = opts.from?.getTime();
        const toMs = opts.to?.getTime();
        const foldedWith = opts.withName ? foldTeamsText(opts.withName) : "";
        const out: MessageRow[] = [];

        for (const raw of rows) {
            const row = mapMessageRow(raw);

            if (opts.conversationId && row.conversationId !== opts.conversationId) {
                continue;
            }

            if (fromMs !== undefined && row.originalArrivalTime < fromMs) {
                continue;
            }

            if (toMs !== undefined && row.originalArrivalTime > toMs) {
                continue;
            }

            if (foldedWith) {
                const conv = this.getConversation(row.conversationId);
                const hay = `${foldTeamsText(row.fromName)} ${foldTeamsText(conv?.title)} ${foldTeamsText(conv?.membersJson)}`;

                if (!hay.includes(foldedWith)) {
                    continue;
                }
            }

            out.push(row);

            if (out.length >= limit) {
                break;
            }
        }

        return out;
    }

    listPeople(query?: string): PeopleRow[] {
        const rows = this.db
            .query(`SELECT mri, display_name, email, upn FROM people ORDER BY display_name`)
            .all() as Array<{
            mri: string;
            display_name: string;
            email: string | null;
            upn: string | null;
        }>;
        const folded = query ? foldTeamsText(query) : "";
        const out: PeopleRow[] = [];

        for (const row of rows) {
            if (folded) {
                const hay = `${foldTeamsText(row.display_name)} ${foldTeamsText(row.email)} ${foldTeamsText(row.upn)}`;

                if (!hay.includes(folded)) {
                    continue;
                }
            }

            out.push({
                mri: row.mri,
                displayName: row.display_name,
                email: row.email,
                upn: row.upn,
            });
        }

        return out;
    }

    listCalls(): CallRow[] {
        const rows = this.db.query(`SELECT * FROM calls ORDER BY start_time DESC`).all() as Array<
            Record<string, unknown>
        >;
        return rows.map((row) => ({
            id: String(row.id),
            startTime: row.start_time ? String(row.start_time) : null,
            endTime: row.end_time ? String(row.end_time) : null,
            callType: row.call_type ? String(row.call_type) : null,
            callState: row.call_state ? String(row.call_state) : null,
            callDirection: row.call_direction ? String(row.call_direction) : null,
            threadId: row.thread_id ? String(row.thread_id) : null,
            summary: String(row.summary ?? ""),
        }));
    }

    listActivity(): ActivityRow[] {
        const rows = this.db.query(`SELECT * FROM activity ORDER BY timestamp DESC`).all() as Array<
            Record<string, unknown>
        >;
        return rows.map((row) => ({
            id: String(row.id),
            activityType: String(row.activity_type ?? ""),
            activitySubtype: row.activity_subtype ? String(row.activity_subtype) : null,
            sourceThreadId: row.source_thread_id ? String(row.source_thread_id) : null,
            sourceMessageId: row.source_message_id ? String(row.source_message_id) : null,
            timestamp: typeof row.timestamp === "number" ? row.timestamp : null,
        }));
    }

    listFiles(
        conversationId?: string
    ): Array<{ conversationId: string; messageId: string; name: string; url: string | null }> {
        const sql = conversationId
            ? `SELECT id, conversation_id, attachments_json FROM messages WHERE conversation_id = ? AND attachments_json != '[]'`
            : `SELECT id, conversation_id, attachments_json FROM messages WHERE attachments_json != '[]'`;
        const rows = conversationId
            ? (this.db.query(sql).all(conversationId) as Array<Record<string, unknown>>)
            : (this.db.query(sql).all() as Array<Record<string, unknown>>);
        const out: Array<{ conversationId: string; messageId: string; name: string; url: string | null }> = [];

        for (const row of rows) {
            let attachments: Array<{ name?: string; url?: string | null }> = [];

            try {
                attachments = SafeJSON.parse(String(row.attachments_json ?? "[]"));
            } catch (err) {
                log.debug({ err }, "[ms-teams] attachments_json parse failed");
                continue;
            }

            if (!Array.isArray(attachments)) {
                continue;
            }

            for (const attachment of attachments) {
                out.push({
                    conversationId: String(row.conversation_id),
                    messageId: String(row.id),
                    name: String(attachment.name ?? "attachment"),
                    url: attachment.url ?? null,
                });
            }
        }

        return out;
    }
}

function mapConversationRow(row: {
    id: string;
    type: ConversationType;
    title: string;
    topic: string | null;
    members_json: string;
    last_message_time: number | null;
    last_preview: string | null;
    member_count: number;
}): ConversationRow {
    return {
        id: row.id,
        type: row.type,
        title: row.title,
        topic: row.topic,
        membersJson: row.members_json,
        lastMessageTime: row.last_message_time,
        lastPreview: row.last_preview,
        memberCount: row.member_count,
    };
}

function mapMessageRow(row: Record<string, unknown>): MessageRow {
    return {
        id: String(row.id),
        conversationId: String(row.conversation_id),
        sequenceId: typeof row.sequence_id === "number" ? row.sequence_id : null,
        version: typeof row.version === "number" ? row.version : null,
        originalArrivalTime: Number(row.original_arrival_time),
        fromMri: row.from_mri ? String(row.from_mri) : null,
        fromName: row.from_name ? String(row.from_name) : null,
        isFromMe: row.is_from_me === 1 || row.is_from_me === true,
        messageType: String(row.message_type ?? ""),
        text: String(row.text ?? ""),
        html: row.html ? String(row.html) : null,
        replyToId: row.reply_to_id ? String(row.reply_to_id) : null,
        reactionsJson: String(row.reactions_json ?? "[]"),
        mentionsJson: String(row.mentions_json ?? "[]"),
        linksJson: String(row.links_json ?? "[]"),
        attachmentsJson: String(row.attachments_json ?? "[]"),
    };
}

export function isOneToOneId(id: string, title: string): boolean {
    return id.includes("@unq.gbl.spaces") && !/\+\d+/.test(title);
}

function escapeFts(query: string): string {
    const cleaned = query.replace(/"/g, '""').trim();
    return `"${cleaned}"`;
}
