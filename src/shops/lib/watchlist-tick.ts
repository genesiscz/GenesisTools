import { FavoritesRepository } from "../db/FavoritesRepository";
import { NotificationsRepository } from "../db/NotificationsRepository";
import { getShopsDatabase, type ShopsDatabase } from "../db/ShopsDatabase";
import { MacOsChannel } from "./channels/MacOsChannel";
import { TelegramBotChannel } from "./channels/TelegramBotChannel";
import type { NotificationChannel } from "./channels/types";
import { WebSseChannel } from "./channels/WebSseChannel";
import { NotificationDispatcher } from "./notification-dispatcher";
import { type TickReport, WatchlistEvaluator } from "./watchlist-evaluator";

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
