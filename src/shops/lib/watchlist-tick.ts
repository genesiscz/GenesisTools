import { FavoritesRepository } from "@app/shops/db/FavoritesRepository";
import { NotificationsRepository } from "@app/shops/db/NotificationsRepository";
import { getShopsDatabase, type ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { MacOsChannel } from "@app/shops/lib/channels/MacOsChannel";
import { TelegramBotChannel } from "@app/shops/lib/channels/TelegramBotChannel";
import type { NotificationChannel } from "@app/shops/lib/channels/types";
import { WebSseChannel } from "@app/shops/lib/channels/WebSseChannel";
import { NotificationDispatcher } from "@app/shops/lib/notification-dispatcher";
import { type TickReport, WatchlistEvaluator } from "@app/shops/lib/watchlist-evaluator";

export interface RunWatchlistTickOptions {
    db?: ShopsDatabase;
    channels?: NotificationChannel[];
}

export function buildDefaultChannels(): NotificationChannel[] {
    const channels: NotificationChannel[] = [new WebSseChannel(), new MacOsChannel()];
    const tg = TelegramBotChannel.fromEnv();
    if (tg) {
        channels.push(tg);
    }

    return channels;
}

export async function runWatchlistTick(opts: RunWatchlistTickOptions = {}): Promise<TickReport> {
    const db = opts.db ?? getShopsDatabase();
    const channels = opts.channels ?? buildDefaultChannels();

    const notifRepo = new NotificationsRepository(db);
    const evaluator = new WatchlistEvaluator({
        db,
        favorites: new FavoritesRepository(db),
        notifications: notifRepo,
        dispatcher: new NotificationDispatcher({ repo: notifRepo, channels }),
    });
    return evaluator.tick();
}
