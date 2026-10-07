import { sendNotification } from "@genesiscz/utils/macos/notifications";

export interface SendOpts {
    title: string;
    subtitle?: string;
    body: string;
    sound?: string;
    /** Stable per-build id so notifications collapse instead of stacking. */
    group: string;
    /** URL opened on click — baked into the notification at OS level. */
    openUrl?: string;
}

/**
 * Routes through `@genesiscz/utils/macos/notifications.sendNotification` on its
 * default chain: GenesisTools.app first, then terminal-notifier, then osascript.
 * Both of the first two bake the click action into the notification at OS
 * level, so a click still opens the URL after the monitor process has exited;
 * the app additionally posts under the GenesisTools icon. It used to pin
 * terminal-notifier, from before the app could post at all.
 */
export class MonitorNotifier {
    async send(opts: SendOpts): Promise<void> {
        await sendNotification({
            title: opts.title,
            subtitle: opts.subtitle,
            message: opts.body,
            sound: opts.sound,
            group: opts.group,
            open: opts.openUrl,
        });
    }
}
