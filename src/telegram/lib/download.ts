import logger from "@app/logger";
import { formatNumber } from "@app/utils/format";
import { detectLanguage, embedText } from "@app/utils/macos/nlp";
import type { EmbedResult } from "@app/utils/macos/types";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { ConversationSyncService, type SyncResult } from "./ConversationSyncService";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { TGClient } from "./TGClient";
import type { ContactConfig } from "./types";
import { EMBEDDING_LANGUAGES } from "./types";

export async function downloadContact(
    client: TGClient,
    store: TelegramHistoryStore,
    contact: ContactConfig,
    options: { since?: Date; until?: Date; limit?: number }
): Promise<void> {
    p.log.step(pc.bold(contact.displayName));

    const spinner = p.spinner();
    spinner.start("Counting messages...");

    let totalEstimate: number;

    try {
        totalEstimate = await client.getMessageCount(contact.userId);
    } catch {
        spinner.stop("Could not count messages");
        totalEstimate = 0;
    }

    const lastSyncedId = store.getLastSyncedId(contact.userId);
    const isIncremental = lastSyncedId !== null && !options.since;

    if (isIncremental) {
        spinner.stop(`Found ${formatNumber(totalEstimate)} total messages (incremental sync from #${lastSyncedId})`);
    } else {
        spinner.stop(`Found ${formatNumber(totalEstimate)} total messages`);
    }

    const progressSpinner = p.spinner();
    progressSpinner.start("Syncing messages...");

    const syncService = new ConversationSyncService(client, store);

    try {
        let result: SyncResult;

        if (options.since || options.until) {
            const since = options.since ?? new Date(0);
            const until = options.until ?? new Date();
            result = await syncService.syncRange(contact.userId, since, until, {
                limit: options.limit,
                onProgress: (synced) => {
                    progressSpinner.message(`Synced ${formatNumber(synced)} messages`);
                },
            });
        } else {
            result = await syncService.syncLatest(contact.userId, {
                limit: options.limit,
                onProgress: (synced) => {
                    progressSpinner.message(`Synced ${formatNumber(synced)} messages`);
                },
            });
        }

        progressSpinner.stop(
            `${pc.green(formatNumber(result.synced))} new messages stored` +
                (result.attachmentsIndexed > 0
                    ? `, ${formatNumber(result.attachmentsIndexed)} attachments indexed`
                    : "")
        );
    } catch (err) {
        progressSpinner.stop("Error during sync");
        p.log.error(`Sync error: ${String(err)}`);
    }
}

export async function embedMessages(
    store: TelegramHistoryStore,
    chatId: string
): Promise<{ embedded: number; skipped: number; unsupportedLangs: Set<string> }> {
    let embedded = 0;
    let skipped = 0;
    const unsupportedLangs = new Set<string>();
    const seenIds = new Set<number>();
    const BATCH_SIZE = 50;

    while (true) {
        const unembedded = store.getUnembeddedMessages(chatId, BATCH_SIZE);

        if (unembedded.length === 0) {
            break;
        }

        const freshMessages = unembedded.filter((msg) => !seenIds.has(msg.id));

        if (freshMessages.length === 0) {
            break;
        }

        for (const msg of freshMessages) {
            seenIds.add(msg.id);

            if (!msg.text || msg.text.trim().length < 3) {
                skipped++;
                continue;
            }

            try {
                const langResult = await detectLanguage(msg.text);

                if (!EMBEDDING_LANGUAGES.has(langResult.language)) {
                    unsupportedLangs.add(langResult.language);
                    skipped++;
                    continue;
                }

                const result: EmbedResult = await embedText(msg.text, langResult.language, "sentence");
                const embedding = new Float32Array(result.vector);
                store.insertEmbedding(chatId, msg.id, embedding);
                embedded++;
            } catch (err) {
                logger.debug(`Embedding failed for message ${msg.id}: ${err}`);
                skipped++;
            }
        }
    }

    return { embedded, skipped, unsupportedLangs };
}
