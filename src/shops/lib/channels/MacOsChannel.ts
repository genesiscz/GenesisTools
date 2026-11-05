import type { DispatchResult, NotificationChannel, NotificationPayload } from "@app/shops/lib/channels/types";
import { CHANNELS, type ChannelReceipt, type NotificationEvent } from "@genesiscz/utils/notifications";

export interface MacOsChannelOptions {
    /** Sends the banner; the shared system channel (GenesisTools.app, else terminal-notifier) by default. Tests pass a spy. */
    post?: (event: NotificationEvent) => Promise<ChannelReceipt>;
    /** Why the banner cannot go out on this machine; undefined when it can. */
    unusable?: () => string | undefined;
}

const SYSTEM = { ...CHANNELS.system.defaults, enabled: true };

/** The shops banner, posted through the one system channel of the notification table. */
export class MacOsChannel implements NotificationChannel {
    readonly name = "macos" as const;
    private readonly post: (event: NotificationEvent) => Promise<ChannelReceipt>;
    private readonly unusable: () => string | undefined;

    constructor(opts: MacOsChannelOptions = {}) {
        this.post = opts.post ?? ((event) => CHANNELS.system.post(event, SYSTEM));
        this.unusable = opts.unusable ?? (() => CHANNELS.system.unusable(SYSTEM));
    }

    available(): boolean {
        return this.unusable() === undefined;
    }

    async dispatch(payload: NotificationPayload): Promise<DispatchResult> {
        if (!this.available()) {
            return { channel: "macos", delivered: false };
        }

        const receipt = await this.post({
            app: "shops",
            title: payload.title,
            message: payload.body,
            open: payload.buyUrl ?? `http://localhost:3073${payload.detailUrl}`,
            group: `shops-${payload.notification.master_product_id}`,
        });

        return receipt.ok
            ? { channel: "macos", delivered: true }
            : { channel: "macos", delivered: false, error: receipt.detail ?? "the system channel did not post it" };
    }
}
