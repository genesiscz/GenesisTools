import type { Api } from "telegram";
import { AttachmentIndexer } from "./AttachmentIndexer";
import { SyncRangePlanner } from "./SyncRangePlanner";
import type { TGClient } from "./TGClient";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { SerializedMessage } from "./TelegramMessage";
import { TelegramMessage } from "./TelegramMessage";

const BATCH_SIZE = 100;
const MAX_RETRIES = 5;

interface SyncOptions {
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

    async syncLatest(chatId: string, options?: SyncOptions): Promise<SyncResult> {
        const lastSyncedId = this.store.getLastSyncedId(chatId);
        let synced = 0;
        let attachmentsIndexed = 0;
        let highestId = lastSyncedId ?? 0;
        let lowestDateUnix = Infinity;
        let highestDateUnix = 0;
        let lowestMsgId = Infinity;

        const iterOptions: { minId?: number; limit?: number } = {};

        if (lastSyncedId) {
            iterOptions.minId = lastSyncedId;
        }

        if (options?.limit) {
            iterOptions.limit = options.limit;
        }

        const batch: SerializedMessage[] = [];

        for await (const rawMsg of this.client.getMessages(chatId, iterOptions)) {
            const msg = new TelegramMessage(rawMsg);
            const serialized = msg.toJSON();
            batch.push(serialized);

            attachmentsIndexed += this.indexAttachments(chatId, rawMsg);

            if (rawMsg.id > highestId) {
                highestId = rawMsg.id;
            }

            if (rawMsg.id < lowestMsgId) {
                lowestMsgId = rawMsg.id;
            }

            if (serialized.dateUnix < lowestDateUnix) {
                lowestDateUnix = serialized.dateUnix;
            }

            if (serialized.dateUnix > highestDateUnix) {
                highestDateUnix = serialized.dateUnix;
            }

            if (batch.length >= BATCH_SIZE) {
                synced += this.store.insertMessages(chatId, batch);
                batch.length = 0;
                options?.onProgress?.(synced, null);
            }
        }

        if (batch.length > 0) {
            synced += this.store.insertMessages(chatId, batch);
        }

        if (highestId > 0) {
            this.store.setLastSyncedId(chatId, highestId);
        }

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
        let retries = 0;

        const batch: SerializedMessage[] = [];

        const iterOptions: { offsetDate?: number; limit?: number } = {
            offsetDate: toUnix,
        };

        if (options?.limit) {
            iterOptions.limit = options.limit;
        }

        try {
            for await (const rawMsg of this.client.getMessages(chatId, iterOptions)) {
                const msg = new TelegramMessage(rawMsg);
                const dateUnix = Math.floor(msg.date.getTime() / 1000);

                if (dateUnix < fromUnix) {
                    break;
                }

                const serialized = msg.toJSON();
                batch.push(serialized);

                attachmentsIndexed += this.indexAttachments(chatId, rawMsg);

                if (rawMsg.id > highestId) {
                    highestId = rawMsg.id;
                }

                if (rawMsg.id < lowestMsgId) {
                    lowestMsgId = rawMsg.id;
                }

                if (batch.length >= BATCH_SIZE) {
                    synced += this.store.insertMessages(chatId, batch);
                    batch.length = 0;
                }
            }
        } catch (err: unknown) {
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

    private indexAttachments(chatId: string, rawMsg: Api.Message): number {
        const atts = AttachmentIndexer.extract(chatId, rawMsg);
        let count = 0;

        for (const att of atts) {
            this.store.upsertAttachment(att);
            count++;
        }

        return count;
    }
}
