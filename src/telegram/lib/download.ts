import logger from "@app/logger";
import { detectLanguage, embedText } from "@app/utils/macos/nlp";
import type { EmbedResult } from "@app/utils/macos/types";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { conversationSyncService } from "./ConversationSyncService";
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

    let totalEstimate = 0;

    try {
        totalEstimate = await client.getMessageCount(contact.userId);
    } catch {
        // ignore counting failures
    }

    spinner.stop(`Found ${totalEstimate.toLocaleString()} total messages`);

    if (options.since || options.until) {
        const since = options.since ?? new Date(0);
        const until = options.until ?? new Date();

        await conversationSyncService.syncRange(client, store, contact.userId, {
            since,
            until,
            limit: options.limit,
            source: "query",
        });
        return;
    }

    await conversationSyncService.syncIncremental(client, store, contact.userId, {
        limit: options.limit,
    });
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
