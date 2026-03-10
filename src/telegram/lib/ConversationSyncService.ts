import { formatNumber } from "@app/utils/format";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { syncRangePlanner } from "./SyncRangePlanner";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import { TelegramMessage } from "./TelegramMessage";
import type { TGClient } from "./TGClient";

export interface SyncOptions {
    since?: Date;
    until?: Date;
    limit?: number;
}

export interface SyncResult {
    downloaded: number;
    inserted: number;
    updated: number;
    highestId: number;
}

interface SyncRangeOptions {
    since?: Date;
    until?: Date;
    limit?: number;
    minId?: number;
    source: "query" | "full" | "incremental";
}

export class ConversationSyncService {
    async syncIncremental(
        client: TGClient,
        store: TelegramHistoryStore,
        chatId: string,
        options: SyncOptions = {}
    ): Promise<SyncResult> {
        const lastSyncedId = store.getLastSyncedId(chatId);
        const plan = syncRangePlanner.planIncremental(lastSyncedId);

        return this.syncRange(client, store, chatId, {
            since: options.since ?? plan.since,
            until: options.until ?? plan.until,
            limit: options.limit,
            minId: lastSyncedId ?? undefined,
            source: plan.source,
        });
    }

    async ensureRange(
        client: TGClient,
        store: TelegramHistoryStore,
        chatId: string,
        since: Date,
        until: Date,
        options: { limit?: number } = {}
    ): Promise<SyncResult[]> {
        const ranges = syncRangePlanner.planQueryBackfill(store, chatId, since, until);
        const results: SyncResult[] = [];

        for (const range of ranges) {
            const result = await this.syncRange(client, store, chatId, {
                since: range.since,
                until: range.until,
                source: "query",
                limit: options.limit,
            });
            results.push(result);
        }

        return results;
    }

    async syncRange(
        client: TGClient,
        store: TelegramHistoryStore,
        chatId: string,
        options: SyncRangeOptions
    ): Promise<SyncResult> {
        const iterOptions: {
            limit?: number;
            offsetDate?: number;
            minId?: number;
        } = {};

        if (options.limit !== undefined) {
            iterOptions.limit = options.limit;
        }

        if (options.until) {
            iterOptions.offsetDate = Math.floor(options.until.getTime() / 1000);
        }

        if (options.minId !== undefined) {
            iterOptions.minId = options.minId;
        }

        const spinner = p.spinner();
        spinner.start(`Syncing ${chatId} (${options.source})...`);

        let downloaded = 0;
        let inserted = 0;
        let updated = 0;
        let highestId = options.minId ?? 0;
        let rangeMin: number | null = null;
        let rangeMax: number | null = null;

        for await (const apiMessage of client.getMessages(chatId, iterOptions)) {
            const message = new TelegramMessage(apiMessage);

            if (options.since && message.date < options.since) {
                continue;
            }

            if (options.until && message.date > options.until) {
                continue;
            }

            const serialized = message.toJSON();
            const revisionType = serialized.editedDateUnix ? "edit" : "create";
            const upsertResult = store.upsertMessageWithRevision(chatId, serialized, revisionType);

            downloaded++;

            if (upsertResult.inserted) {
                inserted++;
            }

            if (upsertResult.updated) {
                updated++;
            }

            if (message.id > highestId) {
                highestId = message.id;
            }

            if (rangeMin === null || serialized.dateUnix < rangeMin) {
                rangeMin = serialized.dateUnix;
            }

            if (rangeMax === null || serialized.dateUnix > rangeMax) {
                rangeMax = serialized.dateUnix;
            }

            if (downloaded % 100 === 0) {
                spinner.message(
                    `Downloaded ${formatNumber(downloaded)} messages (${inserted} new, ${updated} updated)`
                );
            }
        }

        if (highestId > 0) {
            store.setLastSyncedId(chatId, highestId);
        }

        if (rangeMin !== null && rangeMax !== null) {
            store.insertSyncSegment(chatId, rangeMin, rangeMax, options.source);
        }

        if (rangeMin === null && options.since && options.until) {
            store.insertSyncSegment(
                chatId,
                Math.floor(options.since.getTime() / 1000),
                Math.floor(options.until.getTime() / 1000),
                options.source
            );
        }

        spinner.stop(
            `${pc.green(formatNumber(downloaded))} downloaded, ${pc.green(String(inserted))} new, ${pc.yellow(String(updated))} updated`
        );

        return {
            downloaded,
            inserted,
            updated,
            highestId,
        };
    }
}

export const conversationSyncService = new ConversationSyncService();
