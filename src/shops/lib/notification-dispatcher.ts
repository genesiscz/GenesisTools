import logger from "@app/logger";
import type { NotificationsRepository } from "../db/NotificationsRepository";
import type { DispatchResult, NotificationChannel, NotificationPayload } from "./channels/types";

const log = logger.child({ component: "NotificationDispatcher" });

export interface NotificationDispatcherConfig {
    repo: NotificationsRepository;
    channels: NotificationChannel[];
}

export class NotificationDispatcher {
    private readonly repo: NotificationsRepository;
    private readonly channels: NotificationChannel[];

    constructor(config: NotificationDispatcherConfig) {
        this.repo = config.repo;
        this.channels = config.channels;
    }

    async dispatch(payload: NotificationPayload): Promise<DispatchResult[]> {
        const active = this.channels.filter((c) => c.available());
        log.debug({ id: payload.notification.id, channels: active.map((c) => c.name) }, "dispatching notification");

        const settled = await Promise.allSettled(active.map((c) => c.dispatch(payload)));
        const results: DispatchResult[] = settled.map((s, i) => {
            if (s.status === "fulfilled") {
                return s.value;
            }

            return {
                channel: active[i].name,
                delivered: false,
                error: s.reason instanceof Error ? `${s.reason.name}: ${s.reason.message}` : String(s.reason),
            };
        });

        let lastError: string | null = null;
        for (const r of results) {
            if (r.delivered) {
                try {
                    await this.repo.markDelivered(payload.notification.id, r.channel);
                } catch (err) {
                    log.warn({ id: payload.notification.id, channel: r.channel, error: err }, "markDelivered failed");
                }
            } else if (r.error) {
                lastError = `${r.channel}: ${r.error}`;
            }
        }

        if (lastError) {
            try {
                await this.repo.setDeliveryError(payload.notification.id, lastError);
            } catch (err) {
                log.warn({ id: payload.notification.id, error: err }, "setDeliveryError failed");
            }
        }

        return results;
    }
}
