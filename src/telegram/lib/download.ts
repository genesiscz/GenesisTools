import logger from "@app/logger";
import { formatNumber } from "@app/utils/format";
import { detectLanguage, embedText } from "@app/utils/macos/nlp";
import type { EmbedResult } from "@app/utils/macos/types";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { SerializedMessage } from "./TelegramMessage";
import { TelegramMessage } from "./TelegramMessage";
import type { TGClient } from "./TGClient";
import type { ContactConfig } from "./types";
import { EMBEDDING_LANGUAGES } from "./types";

export async function downloadContact(
    client: TGClient,
    store: TelegramHistoryStore,
    contact: ContactConfig,
    options: { since?: Date; until?: Date; limit?: number },
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

    const iterOptions: {
        limit?: number;
        offsetDate?: number;
        minId?: number;
    } = {};

    if (options.limit) {
        iterOptions.limit = options.limit;
    }

    if (options.until) {
        iterOptions.offsetDate = Math.floor(options.until.getTime() / 1000);
    }

    if (isIncremental && lastSyncedId !== null) {
        iterOptions.minId = lastSyncedId;
    }

    const progressSpinner = p.spinner();
    progressSpinner.start("Downloading messages...");

    const batch: SerializedMessage[] = [];
    let downloaded = 0;
    let inserted = 0;
    let highestId = lastSyncedId ?? 0;
    let retryCount = 0;
    const BATCH_SIZE = 100;
    const MAX_RETRIES = 5;

    try {
        for await (const apiMessage of client.getMessages(contact.userId, iterOptions)) {
            const msg = new TelegramMessage(apiMessage);

            if (options.since && msg.date < options.since) {
                continue;
            }

            if (options.until && msg.date > options.until) {
                continue;
            }

            batch.push(msg.toJSON());
            downloaded++;

            if (msg.id > highestId) {
                highestId = msg.id;
            }

            if (batch.length >= BATCH_SIZE) {
                const batchInserted = store.insertMessages(contact.userId, batch);
                inserted += batchInserted;
                batch.length = 0;
                retryCount = 0;

                progressSpinner.message(
                    `Downloaded ${formatNumber(downloaded)} messages (${formatNumber(inserted)} new)`,
                );
            }
        }
    } catch (err) {
        const errorStr = String(err);

        if (errorStr.includes("FLOOD_WAIT") || errorStr.includes("FloodWait")) {
            const waitMatch = errorStr.match(/(\d+)/);
            const waitSeconds = waitMatch ? parseInt(waitMatch[1], 10) : 30;
            retryCount++;

            if (retryCount <= MAX_RETRIES) {
                const backoff = waitSeconds * 2 ** (retryCount - 1);
                progressSpinner.message(`Rate limited — waiting ${backoff}s (retry ${retryCount}/${MAX_RETRIES})`);
                await Bun.sleep(backoff * 1000);
            } else {
                progressSpinner.stop(`Rate limited after ${MAX_RETRIES} retries`);
                p.log.warn("Stopped due to persistent rate limiting. Run again later to resume.");
            }
        } else {
            progressSpinner.stop("Error during download");
            p.log.error(`Download error: ${errorStr}`);
        }
    }

    if (batch.length > 0) {
        const batchInserted = store.insertMessages(contact.userId, batch);
        inserted += batchInserted;
    }

    if (highestId > 0) {
        store.setLastSyncedId(contact.userId, highestId);
    }

    progressSpinner.stop(
        `${pc.green(formatNumber(downloaded))} downloaded, ${pc.green(formatNumber(inserted))} new messages stored`,
    );
}

export async function embedMessages(
    store: TelegramHistoryStore,
    chatId: string,
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
