import logger from "@app/logger";
import { Browser } from "@app/utils/browser";
import { closeDarwinKit, type DarwinKit, getDarwinKit } from "@app/utils/macos/darwinkit";

type DkWithNotifs = DarwinKit & {
    notifications: {
        send(opts: Record<string, unknown>): Promise<{ identifier: string }>;
        onInteraction(handler: (evt: { user_info: Record<string, unknown> }) => void): () => void;
    };
};

export interface SendOpts {
    title: string;
    subtitle?: string;
    body: string;
    sound?: string;
    /** Stable per-build id so notifications collapse instead of stacking. */
    group: string;
    /** URL opened in Brave (or preferred browser) on click. */
    openUrl?: string;
}

/**
 * Owns the DarwinKit lifecycle for a monitor run and routes notification
 * clicks through Browser.open with brave preference.
 * Lazy-inits on first send. Fails silently if DarwinKit can't be loaded —
 * notifications are nice-to-have, never fatal.
 */
export class MonitorNotifier {
    private dk: DkWithNotifs | null = null;
    private unsubscribe: (() => void) | null = null;
    private failed = false;

    private ensure(): DkWithNotifs | null {
        if (this.failed) {
            return null;
        }

        if (this.dk) {
            return this.dk;
        }

        try {
            const candidate = getDarwinKit() as DkWithNotifs;

            if (!candidate.notifications) {
                this.failed = true;
                logger.debug("DarwinKit available but notifications module missing");
                return null;
            }

            this.unsubscribe = candidate.notifications.onInteraction((evt) => {
                const url = evt.user_info?.open;

                if (typeof url === "string") {
                    void Browser.open(url, { browser: "brave" });
                }
            });
            this.dk = candidate;
            return candidate;
        } catch (error) {
            this.failed = true;
            logger.debug(`MonitorNotifier init failed: ${error instanceof Error ? error.message : error}`);
            return null;
        }
    }

    async send(opts: SendOpts): Promise<void> {
        const dk = this.ensure();

        if (!dk) {
            return;
        }

        try {
            await dk.notifications.send({
                title: opts.title,
                subtitle: opts.subtitle,
                body: opts.body,
                sound: opts.sound ? { named: opts.sound } : "default",
                thread_identifier: opts.group,
                user_info: opts.openUrl ? { open: opts.openUrl } : {},
            });
        } catch (error) {
            logger.debug(`Notification send failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    close(): void {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }

        if (this.dk) {
            closeDarwinKit();
            this.dk = null;
        }
    }
}
