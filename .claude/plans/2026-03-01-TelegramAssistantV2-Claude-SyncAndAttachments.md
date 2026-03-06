# Phase 2: Sync Engine & Attachments

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a range-aware sync engine that tracks coverage segments, auto-fetches missing ranges on query, indexes attachment metadata during sync, and supports lazy on-demand attachment downloading. Also wire edit/delete event ingestion and fix sending to return real message IDs.

**Architecture:** `ConversationSyncService` orchestrates sync. `SyncRangePlanner` computes missing date ranges from sync_segments. `AttachmentIndexer` extracts metadata from Telegram API message objects during sync. `AttachmentDownloader` lazily downloads on demand. All built on Phase 1's schema.

**Tech Stack:** telegram (MTProto API), bun:sqlite, crypto (for sha256)

**Prerequisites:** Phase 1 complete (schema migration, query primitives, sync segments, attachment table)

---

## Task 1: SyncRangePlanner

**Files:**
- Create: `src/telegram/lib/SyncRangePlanner.ts`
- Test: `src/telegram/lib/__tests__/SyncRangePlanner.test.ts`

**Step 1: Write the test**

```typescript
import { describe, expect, it } from "bun:test";
import { SyncRangePlanner } from "../SyncRangePlanner";

describe("SyncRangePlanner", () => {
    it("returns full range when no segments exist", () => {
        const plan = SyncRangePlanner.plan([], 1700000000, 1700259200);
        expect(plan.length).toBe(1);
        expect(plan[0]).toEqual({ from: 1700000000, to: 1700259200 });
    });

    it("returns empty when fully covered", () => {
        const segments = [{ from_date_unix: 1700000000, to_date_unix: 1700259200 }];
        const plan = SyncRangePlanner.plan(segments, 1700000000, 1700259200);
        expect(plan.length).toBe(0);
    });

    it("finds gap between two segments", () => {
        const segments = [
            { from_date_unix: 1700000000, to_date_unix: 1700086400 },
            { from_date_unix: 1700172800, to_date_unix: 1700259200 },
        ];
        const plan = SyncRangePlanner.plan(segments, 1700000000, 1700259200);
        expect(plan.length).toBe(1);
        expect(plan[0]).toEqual({ from: 1700086400, to: 1700172800 });
    });

    it("finds gap before first segment", () => {
        const segments = [{ from_date_unix: 1700086400, to_date_unix: 1700259200 }];
        const plan = SyncRangePlanner.plan(segments, 1700000000, 1700259200);
        expect(plan.length).toBe(1);
        expect(plan[0].from).toBe(1700000000);
    });

    it("finds gap after last segment", () => {
        const segments = [{ from_date_unix: 1700000000, to_date_unix: 1700086400 }];
        const plan = SyncRangePlanner.plan(segments, 1700000000, 1700259200);
        expect(plan.length).toBe(1);
        expect(plan[0].from).toBe(1700086400);
    });

    it("handles overlapping segments", () => {
        const segments = [
            { from_date_unix: 1700000000, to_date_unix: 1700100000 },
            { from_date_unix: 1700050000, to_date_unix: 1700259200 },
        ];
        const plan = SyncRangePlanner.plan(segments, 1700000000, 1700259200);
        expect(plan.length).toBe(0); // fully covered by overlap
    });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test src/telegram/lib/__tests__/SyncRangePlanner.test.ts
```

**Step 3: Implement SyncRangePlanner**

```typescript
interface SegmentInput {
    from_date_unix: number;
    to_date_unix: number;
}

interface SyncRange {
    from: number;
    to: number;
}

export class SyncRangePlanner {
    static plan(segments: SegmentInput[], queryFrom: number, queryTo: number): SyncRange[] {
        if (segments.length === 0) {
            return [{ from: queryFrom, to: queryTo }];
        }

        // Sort and merge overlapping segments
        const sorted = [...segments].sort((a, b) => a.from_date_unix - b.from_date_unix);
        const merged: SyncRange[] = [];

        let current = { from: sorted[0].from_date_unix, to: sorted[0].to_date_unix };
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i].from_date_unix <= current.to) {
                current.to = Math.max(current.to, sorted[i].to_date_unix);
            } else {
                merged.push(current);
                current = { from: sorted[i].from_date_unix, to: sorted[i].to_date_unix };
            }
        }
        merged.push(current);

        // Find gaps within query range
        const gaps: SyncRange[] = [];
        const clipped = merged.filter((s) => s.to > queryFrom && s.from < queryTo);

        if (clipped.length === 0) {
            return [{ from: queryFrom, to: queryTo }];
        }

        // Gap before first
        if (clipped[0].from > queryFrom) {
            gaps.push({ from: queryFrom, to: clipped[0].from });
        }

        // Gaps between
        for (let i = 0; i < clipped.length - 1; i++) {
            if (clipped[i + 1].from > clipped[i].to) {
                gaps.push({ from: clipped[i].to, to: clipped[i + 1].from });
            }
        }

        // Gap after last
        if (clipped[clipped.length - 1].to < queryTo) {
            gaps.push({ from: clipped[clipped.length - 1].to, to: queryTo });
        }

        return gaps;
    }
}
```

**Step 4: Run test to verify it passes**

```bash
bun test src/telegram/lib/__tests__/SyncRangePlanner.test.ts
```

**Step 5: Commit**

```bash
git add src/telegram/lib/SyncRangePlanner.ts src/telegram/lib/__tests__/SyncRangePlanner.test.ts
git commit -m "feat(telegram): SyncRangePlanner with gap detection and overlap merging"
```

---

## Task 2: AttachmentIndexer

**Files:**
- Create: `src/telegram/lib/AttachmentIndexer.ts`
- Test: `src/telegram/lib/__tests__/AttachmentIndexer.test.ts`

**Context:** During sync, each Telegram API message may have media. We need to extract attachment metadata (kind, mime, filename, size, file_id) and call `store.upsertAttachment()`. This module normalizes the various Telegram media types into our schema.

**Step 1: Write the test**

```typescript
import { describe, expect, it } from "bun:test";
import { AttachmentIndexer } from "../AttachmentIndexer";

describe("AttachmentIndexer", () => {
    it("extracts photo attachment", () => {
        const fakeMessage = {
            id: 1,
            media: {
                className: "MessageMediaPhoto",
                photo: {
                    id: { value: BigInt(12345) },
                    sizes: [{ type: "x", w: 800, h: 600, size: 50000 }],
                    mimeType: "image/jpeg",
                },
            },
        };

        const attachments = AttachmentIndexer.extract("chat1", fakeMessage as any);
        expect(attachments.length).toBe(1);
        expect(attachments[0].kind).toBe("photo");
        expect(attachments[0].attachment_index).toBe(0);
    });

    it("extracts document attachment with filename", () => {
        const fakeMessage = {
            id: 2,
            media: {
                className: "MessageMediaDocument",
                document: {
                    id: { value: BigInt(67890) },
                    mimeType: "application/pdf",
                    size: BigInt(1024),
                    attributes: [
                        { className: "DocumentAttributeFilename", fileName: "report.pdf" },
                    ],
                },
            },
        };

        const attachments = AttachmentIndexer.extract("chat1", fakeMessage as any);
        expect(attachments.length).toBe(1);
        expect(attachments[0].kind).toBe("document");
        expect(attachments[0].file_name).toBe("report.pdf");
        expect(attachments[0].mime_type).toBe("application/pdf");
    });

    it("returns empty for text-only message", () => {
        const fakeMessage = { id: 3, media: null };
        const attachments = AttachmentIndexer.extract("chat1", fakeMessage as any);
        expect(attachments.length).toBe(0);
    });

    it("classifies sticker correctly", () => {
        const fakeMessage = {
            id: 4,
            media: {
                className: "MessageMediaDocument",
                document: {
                    id: { value: BigInt(11111) },
                    mimeType: "image/webp",
                    size: BigInt(5000),
                    attributes: [{ className: "DocumentAttributeSticker" }],
                },
            },
        };

        const attachments = AttachmentIndexer.extract("chat1", fakeMessage as any);
        expect(attachments[0].kind).toBe("sticker");
    });

    it("classifies voice message correctly", () => {
        const fakeMessage = {
            id: 5,
            media: {
                className: "MessageMediaDocument",
                document: {
                    id: { value: BigInt(22222) },
                    mimeType: "audio/ogg",
                    size: BigInt(8000),
                    attributes: [{ className: "DocumentAttributeAudio", voice: true }],
                },
            },
        };

        const attachments = AttachmentIndexer.extract("chat1", fakeMessage as any);
        expect(attachments[0].kind).toBe("voice");
    });
});
```

**Step 2: Implement AttachmentIndexer**

```typescript
import type { UpsertAttachmentInput } from "./types"; // we'll add this type alias

export class AttachmentIndexer {
    static extract(chatId: string, message: any): UpsertAttachmentInput[] {
        if (!message.media) {
            return [];
        }

        const results: UpsertAttachmentInput[] = [];
        const media = message.media;
        const msgId = message.id;

        switch (media.className) {
            case "MessageMediaPhoto": {
                const photo = media.photo;
                if (!photo) break;
                const largestSize = photo.sizes?.at(-1);
                results.push({
                    chat_id: chatId,
                    message_id: msgId,
                    attachment_index: 0,
                    kind: "photo",
                    mime_type: "image/jpeg",
                    file_name: null,
                    file_size: largestSize?.size ?? null,
                    telegram_file_id: photo.id ? String(photo.id.value ?? photo.id) : null,
                });
                break;
            }

            case "MessageMediaDocument": {
                const doc = media.document;
                if (!doc) break;

                const kind = this.classifyDocument(doc.attributes ?? []);
                const fileName = this.extractFileName(doc.attributes ?? []);

                results.push({
                    chat_id: chatId,
                    message_id: msgId,
                    attachment_index: 0,
                    kind,
                    mime_type: doc.mimeType ?? null,
                    file_name: fileName,
                    file_size: doc.size ? Number(doc.size) : null,
                    telegram_file_id: doc.id ? String(doc.id.value ?? doc.id) : null,
                });
                break;
            }

            // Geo, contact, poll etc. — no downloadable attachment
            default:
                break;
        }

        return results;
    }

    private static classifyDocument(attributes: any[]): string {
        for (const attr of attributes) {
            switch (attr.className) {
                case "DocumentAttributeSticker":
                    return "sticker";
                case "DocumentAttributeAudio":
                    return attr.voice ? "voice" : "audio";
                case "DocumentAttributeVideo":
                    return attr.roundMessage ? "video_note" : "video";
                case "DocumentAttributeAnimated":
                    return "animation";
            }
        }
        return "document";
    }

    private static extractFileName(attributes: any[]): string | null {
        for (const attr of attributes) {
            if (attr.className === "DocumentAttributeFilename") {
                return attr.fileName ?? null;
            }
        }
        return null;
    }
}
```

**Step 3: Run test, commit**

```bash
bun test src/telegram/lib/__tests__/AttachmentIndexer.test.ts
git add src/telegram/lib/AttachmentIndexer.ts src/telegram/lib/__tests__/AttachmentIndexer.test.ts
git commit -m "feat(telegram): attachment metadata extraction from Telegram API messages"
```

---

## Task 3: AttachmentDownloader

**Files:**
- Create: `src/telegram/lib/AttachmentDownloader.ts`

**Context:** Downloads a specific attachment by message ID + attachment index. Uses `client.raw.downloadMedia()` from the telegram MTProto library. Saves to `~/.genesis-tools/telegram/chats/<chat_id>/attachments/`. Computes SHA-256 and updates the DB.

**Step 1: Implement AttachmentDownloader**

```typescript
import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { TGClient } from "./TGClient";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";

const ATTACHMENTS_BASE = resolve(homedir(), ".genesis-tools/telegram/chats");

export class AttachmentDownloader {
    constructor(
        private client: TGClient,
        private store: TelegramHistoryStore,
    ) {}

    async download(
        chatId: string,
        messageId: number,
        attachmentIndex: number,
        outputPath?: string,
    ): Promise<{ path: string; size: number; sha256: string }> {
        // Get attachment record
        const attachments = this.store.getAttachments(chatId, messageId);
        const attachment = attachments.find((a) => a.attachment_index === attachmentIndex);

        if (!attachment) {
            throw new Error(`Attachment not found: chat=${chatId} msg=${messageId} idx=${attachmentIndex}`);
        }

        if (attachment.is_downloaded && attachment.local_path && existsSync(attachment.local_path)) {
            return {
                path: attachment.local_path,
                size: attachment.file_size ?? 0,
                sha256: attachment.sha256 ?? "",
            };
        }

        // Fetch the message from Telegram to get the media object
        const messages = [];
        for await (const msg of this.client.getMessages(chatId, { minId: messageId - 1, maxId: messageId + 1, limit: 1 })) {
            if (msg.id === messageId) {
                messages.push(msg);
            }
        }

        if (messages.length === 0 || !messages[0].media) {
            throw new Error(`Message ${messageId} not found or has no media`);
        }

        // Determine output path
        const dir = outputPath
            ? resolve(outputPath, "..")
            : resolve(ATTACHMENTS_BASE, chatId, "attachments");

        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        const ext = this.guessExtension(attachment.mime_type, attachment.file_name);
        const fileName = outputPath
            ? resolve(outputPath)
            : resolve(dir, `${messageId}-${attachmentIndex}${ext}`);

        // Download using telegram client
        const buffer = await this.client.raw.downloadMedia(messages[0].media, {}) as Buffer;

        if (!buffer) {
            throw new Error("Download returned empty buffer");
        }

        // Write file
        await Bun.write(fileName, buffer);

        // Compute SHA-256
        const hash = createHash("sha256").update(buffer).digest("hex");

        // Update DB
        this.store.markAttachmentDownloaded(chatId, messageId, attachmentIndex, fileName, hash);

        return { path: fileName, size: buffer.length, sha256: hash };
    }

    private guessExtension(mimeType: string | null, fileName: string | null): string {
        if (fileName) {
            const dot = fileName.lastIndexOf(".");
            if (dot !== -1) {
                return fileName.slice(dot);
            }
        }

        const mimeMap: Record<string, string> = {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp",
            "image/gif": ".gif",
            "video/mp4": ".mp4",
            "audio/ogg": ".ogg",
            "audio/mpeg": ".mp3",
            "application/pdf": ".pdf",
        };

        return mimeMap[mimeType ?? ""] ?? "";
    }
}
```

**Step 2: Type check**

```bash
bunx tsgo --noEmit | rg "src/telegram"
```

**Step 3: Commit**

```bash
git add src/telegram/lib/AttachmentDownloader.ts
git commit -m "feat(telegram): lazy attachment downloader with SHA-256 verification"
```

---

## Task 4: ConversationSyncService

**Files:**
- Create: `src/telegram/lib/ConversationSyncService.ts`

**Context:** This is the main sync orchestrator. It replaces the direct download logic in `download.ts`. It handles:
1. **Latest incremental** — uses `sync_state.last_synced_id` (high-watermark)
2. **Range backfill** — uses `SyncRangePlanner` to find gaps, fetches missing ranges
3. **Attachment indexing** — calls `AttachmentIndexer.extract()` during sync
4. **Segment recording** — inserts sync_segments after each batch

**Step 1: Implement ConversationSyncService**

```typescript
import type { TGClient } from "./TGClient";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import { TelegramMessage } from "./TelegramMessage";
import { SyncRangePlanner } from "./SyncRangePlanner";
import { AttachmentIndexer } from "./AttachmentIndexer";

const BATCH_SIZE = 100;
const MAX_RETRIES = 5;

interface SyncOptions {
    since?: Date;
    until?: Date;
    limit?: number;
    onProgress?: (synced: number, total: number | null) => void;
}

interface SyncResult {
    synced: number;
    attachmentsIndexed: number;
    segments: number;
}

export class ConversationSyncService {
    constructor(
        private client: TGClient,
        private store: TelegramHistoryStore,
    ) {}

    /**
     * Full incremental sync — fetches all new messages since last sync.
     * Uses high-watermark (last_synced_id).
     */
    async syncLatest(chatId: string, options?: SyncOptions): Promise<SyncResult> {
        const lastSyncedId = this.store.getLastSyncedId(chatId);
        let synced = 0;
        let attachmentsIndexed = 0;
        let highestId = lastSyncedId ?? 0;
        let lowestDateUnix = Infinity;
        let highestDateUnix = 0;
        let lowestMsgId = Infinity;

        const iterOptions: Record<string, unknown> = {};
        if (lastSyncedId) {
            iterOptions.minId = lastSyncedId;
        }
        if (options?.limit) {
            iterOptions.limit = options.limit;
        }

        const batch: Array<ReturnType<TelegramMessage["toJSON"]>> = [];

        for await (const rawMsg of this.client.getMessages(chatId, iterOptions)) {
            const msg = new TelegramMessage(rawMsg);
            const serialized = msg.toJSON();
            batch.push(serialized);

            // Index attachments
            const atts = AttachmentIndexer.extract(chatId, rawMsg);
            for (const att of atts) {
                this.store.upsertAttachment(att);
                attachmentsIndexed++;
            }

            // Track bounds
            if (rawMsg.id > highestId) highestId = rawMsg.id;
            if (rawMsg.id < lowestMsgId) lowestMsgId = rawMsg.id;
            if (serialized.dateUnix < lowestDateUnix) lowestDateUnix = serialized.dateUnix;
            if (serialized.dateUnix > highestDateUnix) highestDateUnix = serialized.dateUnix;

            if (batch.length >= BATCH_SIZE) {
                synced += this.store.insertMessages(chatId, batch);
                batch.length = 0;
                options?.onProgress?.(synced, null);
            }
        }

        if (batch.length > 0) {
            synced += this.store.insertMessages(chatId, batch);
        }

        // Update sync state
        if (highestId > 0) {
            this.store.setLastSyncedId(chatId, highestId);
        }

        // Record segment
        let segmentsRecorded = 0;
        if (synced > 0 && lowestDateUnix < Infinity) {
            this.store.insertSyncSegment(chatId, {
                fromDateUnix: lowestDateUnix,
                toDateUnix: highestDateUnix,
                fromMsgId: lowestMsgId,
                toMsgId: highestId,
            });
            segmentsRecorded = 1;
        }

        return { synced, attachmentsIndexed, segments: segmentsRecorded };
    }

    /**
     * Range-aware sync — fetches missing date ranges using SyncRangePlanner.
     * Used by query auto-fetch.
     */
    async syncRange(chatId: string, since: Date, until: Date, options?: SyncOptions): Promise<SyncResult> {
        const sinceUnix = Math.floor(since.getTime() / 1000);
        const untilUnix = Math.floor(until.getTime() / 1000);

        const segments = this.store.getSyncSegments(chatId);
        const gaps = SyncRangePlanner.plan(
            segments.map((s) => ({ from_date_unix: s.from_date_unix, to_date_unix: s.to_date_unix })),
            sinceUnix,
            untilUnix,
        );

        if (gaps.length === 0) {
            return { synced: 0, attachmentsIndexed: 0, segments: 0 };
        }

        let totalSynced = 0;
        let totalAttachments = 0;
        let totalSegments = 0;

        for (const gap of gaps) {
            const result = await this.syncDateRange(chatId, gap.from, gap.to, options);
            totalSynced += result.synced;
            totalAttachments += result.attachmentsIndexed;
            totalSegments += result.segments;
        }

        return { synced: totalSynced, attachmentsIndexed: totalAttachments, segments: totalSegments };
    }

    private async syncDateRange(
        chatId: string,
        fromUnix: number,
        toUnix: number,
        options?: SyncOptions,
    ): Promise<SyncResult> {
        let synced = 0;
        let attachmentsIndexed = 0;
        let highestId = 0;
        let lowestMsgId = Infinity;

        const batch: Array<ReturnType<TelegramMessage["toJSON"]>> = [];
        let retries = 0;

        const iterOptions = {
            offsetDate: toUnix,
            limit: options?.limit,
        };

        try {
            for await (const rawMsg of this.client.getMessages(chatId, iterOptions)) {
                const msg = new TelegramMessage(rawMsg);
                const dateUnix = Math.floor(msg.date.getTime() / 1000);

                // Stop if we've gone past the range
                if (dateUnix < fromUnix) break;

                const serialized = msg.toJSON();
                batch.push(serialized);

                // Index attachments
                const atts = AttachmentIndexer.extract(chatId, rawMsg);
                for (const att of atts) {
                    this.store.upsertAttachment(att);
                    attachmentsIndexed++;
                }

                if (rawMsg.id > highestId) highestId = rawMsg.id;
                if (rawMsg.id < lowestMsgId) lowestMsgId = rawMsg.id;

                if (batch.length >= BATCH_SIZE) {
                    synced += this.store.insertMessages(chatId, batch);
                    batch.length = 0;
                }
            }
        } catch (err: unknown) {
            // Handle FLOOD_WAIT
            if (err instanceof Error && err.message.includes("FLOOD_WAIT")) {
                const match = err.message.match(/FLOOD_WAIT_(\d+)/);
                const waitSeconds = match ? Number.parseInt(match[1], 10) : 30;
                if (retries < MAX_RETRIES) {
                    retries++;
                    await Bun.sleep(waitSeconds * 1000 * 2 ** (retries - 1));
                    return this.syncDateRange(chatId, fromUnix, toUnix, options);
                }
            }
            throw err;
        }

        if (batch.length > 0) {
            synced += this.store.insertMessages(chatId, batch);
        }

        // Record segment
        if (synced > 0) {
            this.store.insertSyncSegment(chatId, {
                fromDateUnix: fromUnix,
                toDateUnix: toUnix,
                fromMsgId: lowestMsgId,
                toMsgId: highestId,
            });
        }

        return { synced, attachmentsIndexed, segments: synced > 0 ? 1 : 0 };
    }

    /**
     * Auto-fetch for queries: checks coverage, fetches gaps, returns local results.
     */
    async queryWithAutoFetch(
        chatId: string,
        options: {
            sender?: "me" | "them" | "any";
            since?: Date;
            until?: Date;
            textPattern?: string;
            limit?: number;
            localOnly?: boolean;
        },
    ) {
        // If not local-only, ensure coverage
        if (!options.localOnly && (options.since || options.until)) {
            const since = options.since ?? new Date(0);
            const until = options.until ?? new Date();
            await this.syncRange(chatId, since, until);
        }

        return this.store.queryMessages(chatId, {
            sender: options.sender,
            since: options.since,
            until: options.until,
            textPattern: options.textPattern,
            limit: options.limit,
        });
    }
}
```

**Step 2: Type check**

```bash
bunx tsgo --noEmit | rg "src/telegram"
```

**Step 3: Commit**

```bash
git add src/telegram/lib/ConversationSyncService.ts
git commit -m "feat(telegram): ConversationSyncService with range-aware auto-fetch"
```

---

## Task 5: Wire Edit/Delete Events into TGClient

**Files:**
- Modify: `src/telegram/lib/TGClient.ts`

**Context:** Currently TGClient only has `onNewMessage`. We need `onEditedMessage` and `onDeletedMessage` event handlers.

**Step 1: Add event handlers to TGClient**

Add to `src/telegram/lib/TGClient.ts`:

```typescript
import { EditedMessage, DeletedMessage } from "telegram/events";

onEditedMessage(handler: (event: any) => Promise<void>): void {
    this.client.addEventHandler(handler, new EditedMessage({}));
}

onDeletedMessage(handler: (event: any) => Promise<void>): void {
    this.client.addEventHandler(handler, new DeletedMessage({}));
}
```

**Note:** Check exact import paths from `telegram` package. The `EditedMessage` event class may be at `telegram/events/EditedMessage` — verify with:

```bash
bunx tsgo --noEmit | rg "EditedMessage"
```

If the imports don't exist in grammy/telegram, use the raw event handler approach:

```typescript
onEditedMessage(handler: (event: any) => Promise<void>): void {
    this.client.addEventHandler(
        async (update: any) => {
            if (update.className === "UpdateEditMessage" || update.className === "UpdateEditChannelMessage") {
                await handler(update);
            }
        }
    );
}
```

**Step 2: Type check and commit**

```bash
bunx tsgo --noEmit | rg "src/telegram"
git add src/telegram/lib/TGClient.ts
git commit -m "feat(telegram): add edit/delete message event handlers to TGClient"
```

---

## Task 6: Wire Edit/Delete Handling into handler.ts

**Files:**
- Modify: `src/telegram/lib/handler.ts`

**Context:** When an edited message arrives, we should call `store.upsertMessageWithRevision()`. When a deleted message arrives, call `store.markMessageDeleted()`.

**Step 1: Add edit/delete handlers to registerHandler()**

In `src/telegram/lib/handler.ts`, inside `registerHandler()`, after the existing `client.onNewMessage()` registration:

```typescript
// Handle edited messages
client.onEditedMessage(async (event) => {
    try {
        const message = event.message;
        if (!message) return;

        const msg = new TelegramMessage(message);
        const chatId = msg.senderId ?? String(message.peerId?.userId ?? message.peerId?.chatId ?? message.peerId?.channelId);
        if (!chatId) return;

        store.upsertMessageWithRevision(chatId, {
            id: msg.id,
            senderId: msg.senderId,
            text: msg.text,
            mediaDescription: msg.mediaDescription,
            isOutgoing: msg.isOutgoing,
            date: msg.date.toISOString(),
            dateUnix: Math.floor(msg.date.getTime() / 1000),
            editedDateUnix: message.editDate ?? Math.floor(Date.now() / 1000),
        });
    } catch (err) {
        logger.error({ err }, "Error handling edited message");
    }
});

// Handle deleted messages
client.onDeletedMessage(async (event) => {
    try {
        const deletedIds: number[] = event.deletedIds ?? [];
        // We don't know the chat_id from delete events in MTProto,
        // so we search all chats for each deleted ID
        for (const msgId of deletedIds) {
            // Try to find which chat this message belongs to
            const row = store.findMessageById(msgId);
            if (row) {
                store.markMessageDeleted(row.chat_id, msgId);
            }
        }
    } catch (err) {
        logger.error({ err }, "Error handling deleted message");
    }
});
```

**Step 2: Add findMessageById to TelegramHistoryStore**

```typescript
findMessageById(messageId: number): { chat_id: string } | null {
    const db = this.db!;
    return (db.query("SELECT chat_id FROM messages WHERE id = ? LIMIT 1").get(messageId) as { chat_id: string }) ?? null;
}
```

**Step 3: Type check and commit**

```bash
bunx tsgo --noEmit | rg "src/telegram"
git add src/telegram/lib/handler.ts src/telegram/lib/TelegramHistoryStore.ts
git commit -m "feat(telegram): wire edit/delete events into handler with revision tracking"
```

---

## Task 7: Fix sendMessage to Return Real Message IDs

**Files:**
- Modify: `src/telegram/lib/TGClient.ts`

**Context:** Currently `sendMessage` returns `void`. We need it to return the Telegram `Api.Message` so we can persist the real message ID.

**Step 1: Update sendMessage signature and implementation**

In `src/telegram/lib/TGClient.ts`:

```typescript
// Before:
async sendMessage(userId: string, text: string): Promise<void> {
    await this.client.sendMessage(userId, { message: text });
}

// After:
async sendMessage(userId: string, text: string): Promise<Api.Message> {
    const result = await this.client.sendMessage(userId, { message: text });
    return result;
}
```

**Step 2: Update handler.ts to persist outgoing messages with real IDs**

In `handler.ts`, where the ask action result is handled, after `client.sendMessage()`:

```typescript
// In the ask action success handler:
const sentMessage = await client.sendMessage(contact.userId, response.content);
store.insertMessages(contact.userId, [{
    id: sentMessage.id,
    senderId: myId,
    text: response.content,
    mediaDescription: undefined,
    isOutgoing: true,
    date: new Date().toISOString(),
    dateUnix: Math.floor(Date.now() / 1000),
}]);
```

**Step 3: Type check and commit**

```bash
bunx tsgo --noEmit | rg "src/telegram"
git add src/telegram/lib/TGClient.ts src/telegram/lib/handler.ts
git commit -m "fix(telegram): sendMessage returns Api.Message for real ID persistence"
```

---

## Task 8: Update download.ts to Use ConversationSyncService

**Files:**
- Modify: `src/telegram/lib/download.ts`

**Context:** The existing `downloadContact()` function has its own sync logic. Refactor it to delegate to `ConversationSyncService` while keeping the same external interface.

**Step 1: Refactor downloadContact**

```typescript
import { ConversationSyncService } from "./ConversationSyncService";

export async function downloadContact(
    client: TGClient,
    store: TelegramHistoryStore,
    contact: ContactConfig,
    options: { since?: Date; until?: Date; limit?: number } = {},
): Promise<number> {
    const syncService = new ConversationSyncService(client, store);

    if (options.since || options.until) {
        // Range sync
        const since = options.since ?? new Date(0);
        const until = options.until ?? new Date();
        const result = await syncService.syncRange(contact.userId, since, until, { limit: options.limit });
        return result.synced;
    }

    // Incremental latest sync
    const result = await syncService.syncLatest(contact.userId, { limit: options.limit });
    return result.synced;
}
```

Keep `embedMessages()` unchanged.

**Step 2: Type check, run existing functionality**

```bash
bunx tsgo --noEmit | rg "src/telegram"
```

**Step 3: Commit**

```bash
git add src/telegram/lib/download.ts
git commit -m "refactor(telegram): delegate download to ConversationSyncService"
```

---

## Task 9: Update History Command with Query Subcommand

**Files:**
- Modify: `src/telegram/commands/history.ts`

**Context:** Add `history query` subcommand that uses `ConversationSyncService.queryWithAutoFetch()` and `DateParser` for natural language dates.

**Step 1: Add query subcommand**

Add to the history command registration in `src/telegram/commands/history.ts`:

```typescript
import { parseDate } from "../lib/DateParser";
import { ConversationSyncService } from "../lib/ConversationSyncService";

history
    .command("query")
    .description("Query messages with filters, auto-fetching missing ranges")
    .requiredOption("--from <contact>", "Contact name or ID")
    .option("--since <date>", "Start date (natural language or YYYY-MM-DD)")
    .option("--until <date>", "End date (natural language or YYYY-MM-DD)")
    .option("--sender <who>", "Filter by sender: me, them, any", "any")
    .option("--text <pattern>", "Text pattern to search")
    .option("--local-only", "Don't fetch from Telegram, only search local DB")
    .option("--limit <n>", "Max results", parseInt)
    .action(async (opts) => {
        const config = new TelegramToolConfig();
        const data = await config.load();
        if (!data) { console.error("Not configured"); process.exit(1); }

        const contact = data.contacts.find(
            (c) => c.displayName.toLowerCase() === opts.from.toLowerCase()
                || c.userId === opts.from
                || c.username?.toLowerCase() === opts.from.toLowerCase()
        );
        if (!contact) { console.error(`Contact not found: ${opts.from}`); process.exit(1); }

        const since = opts.since ? parseDate(opts.since) ?? undefined : undefined;
        const until = opts.until ? parseDate(opts.until) ?? undefined : undefined;

        const client = TGClient.fromConfig(config);
        await client.connect();
        const store = new TelegramHistoryStore();
        store.open();

        const syncService = new ConversationSyncService(client, store);
        const results = await syncService.queryWithAutoFetch(contact.userId, {
            sender: opts.sender as "me" | "them" | "any",
            since,
            until,
            textPattern: opts.text,
            limit: opts.limit,
            localOnly: opts.localOnly,
        });

        // Display results
        for (const msg of results) {
            const direction = msg.is_outgoing ? "→" : "←";
            const date = new Date(msg.date_unix * 1000).toLocaleString();
            const text = msg.text ?? "[media]";
            console.log(`${date} ${direction} ${text}`);
        }

        console.log(`\n${results.length} message(s) found`);

        store.close();
        await client.disconnect();
    });
```

**Step 2: Add attachment list/fetch subcommands**

```typescript
const attachments = history.command("attachments").description("Manage message attachments");

attachments
    .command("list")
    .description("List attachment metadata for a contact")
    .requiredOption("--from <contact>", "Contact name or ID")
    .option("--since <date>", "Start date")
    .option("--until <date>", "End date")
    .option("--message-id <id>", "Specific message ID", parseInt)
    .action(async (opts) => {
        const store = new TelegramHistoryStore();
        store.open();

        const contact = await resolveContact(opts.from);
        if (!contact) { process.exit(1); }

        if (opts.messageId) {
            const atts = store.getAttachments(contact.userId, opts.messageId);
            for (const att of atts) {
                const dl = att.is_downloaded ? "✓" : "✗";
                console.log(`  [${dl}] ${att.kind} idx=${att.attachment_index} ${att.file_name ?? ""} ${att.file_size ? `(${att.file_size}b)` : ""}`);
            }
        } else {
            const since = opts.since ? parseDate(opts.since) ?? undefined : undefined;
            const until = opts.until ? parseDate(opts.until) ?? undefined : undefined;
            const atts = store.listAttachments(contact.userId, { since, until });
            for (const att of atts) {
                const dl = att.is_downloaded ? "✓" : "✗";
                console.log(`msg:${att.message_id} [${dl}] ${att.kind} idx=${att.attachment_index} ${att.file_name ?? ""}`);
            }
            console.log(`\n${atts.length} attachment(s)`);
        }

        store.close();
    });

attachments
    .command("fetch")
    .description("Download a specific attachment")
    .requiredOption("--from <contact>", "Contact name or ID")
    .requiredOption("--message-id <id>", "Message ID", parseInt)
    .option("--attachment-index <n>", "Attachment index (default 0)", parseInt, 0)
    .option("--output <path>", "Output file path")
    .action(async (opts) => {
        const config = new TelegramToolConfig();
        const data = await config.load();
        if (!data) { process.exit(1); }

        const contact = data.contacts.find(
            (c) => c.displayName.toLowerCase() === opts.from.toLowerCase() || c.userId === opts.from
        );
        if (!contact) { process.exit(1); }

        const client = TGClient.fromConfig(config);
        await client.connect();
        const store = new TelegramHistoryStore();
        store.open();

        const downloader = new AttachmentDownloader(client, store);
        const result = await downloader.download(contact.userId, opts.messageId, opts.attachmentIndex, opts.output);

        console.log(`Downloaded to: ${result.path}`);
        console.log(`Size: ${result.size} bytes`);
        console.log(`SHA-256: ${result.sha256}`);

        store.close();
        await client.disconnect();
    });
```

**Step 3: Type check and commit**

```bash
bunx tsgo --noEmit | rg "src/telegram"
git add src/telegram/commands/history.ts
git commit -m "feat(telegram): query and attachment CLI subcommands with auto-fetch"
```

---

## Task 10: Phase 2 Verification

**Step 1: Run all tests**

```bash
bun test src/telegram/
```

**Step 2: Type check**

```bash
bunx tsgo --noEmit | rg "src/telegram"
```

**Step 3: Lint**

```bash
bunx biome check src/telegram
```

**Step 4: Manual smoke test**

```bash
# Sync a contact
tools telegram history sync <contact_name>

# Query with natural language dates
tools telegram history query --from <contact> --since "last week"

# List attachments
tools telegram history attachments list --from <contact>
```

**Step 5: Commit any fixes**

```bash
git add src/telegram/
git commit -m "fix(telegram): Phase 2 lint and type fixes"
```

---

## Summary of Phase 2 Deliverables

| Component | File | Status |
|-----------|------|--------|
| SyncRangePlanner | `src/telegram/lib/SyncRangePlanner.ts` | Task 1 |
| AttachmentIndexer | `src/telegram/lib/AttachmentIndexer.ts` | Task 2 |
| AttachmentDownloader | `src/telegram/lib/AttachmentDownloader.ts` | Task 3 |
| ConversationSyncService | `src/telegram/lib/ConversationSyncService.ts` | Task 4 |
| Edit/delete events on TGClient | `src/telegram/lib/TGClient.ts` | Task 5 |
| Edit/delete handling in handler | `src/telegram/lib/handler.ts` | Task 6 |
| sendMessage returns real IDs | `src/telegram/lib/TGClient.ts` | Task 7 |
| download.ts delegates to SyncService | `src/telegram/lib/download.ts` | Task 8 |
| history query + attachments commands | `src/telegram/commands/history.ts` | Task 9 |
