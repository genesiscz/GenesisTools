import logger from "@app/logger";
import { type SseBroadcaster, sseBroadcaster } from "@app/shops/lib/sse-broadcaster";
import type { DispatchResult, NotificationChannel, NotificationPayload } from "@app/shops/lib/channels/types";

const log = logger.child({ component: "WebSseChannel" });

export class WebSseChannel implements NotificationChannel {
    readonly name = "web" as const;

    constructor(private readonly broadcaster: SseBroadcaster = sseBroadcaster) {}

    available(): boolean {
        return true;
    }

    async dispatch(payload: NotificationPayload): Promise<DispatchResult> {
        try {
            this.broadcaster.publish("notification-fired", {
                id: payload.notification.id,
                favorite_id: payload.notification.favorite_id,
                master_product_id: payload.notification.master_product_id,
                product_id: payload.notification.product_id,
                reason: payload.notification.reason,
                prev_price: payload.notification.prev_price,
                curr_price: payload.notification.curr_price,
                shop_origin: payload.notification.shop_origin,
                fired_at: payload.notification.fired_at,
                title: payload.title,
                body: payload.body,
                detailUrl: payload.detailUrl,
                buyUrl: payload.buyUrl,
            });
            log.debug({ id: payload.notification.id }, "notification-fired published");
            return { channel: "web", delivered: true };
        } catch (err) {
            return {
                channel: "web",
                delivered: false,
                error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            };
        }
    }
}
