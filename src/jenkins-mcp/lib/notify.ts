import { existsSync } from "node:fs";
import logger from "@app/logger";

export interface SendOpts {
    title: string;
    subtitle?: string;
    body: string;
    sound?: string;
    /** Stable per-build id so notifications collapse instead of stacking. */
    group: string;
    /** URL opened on click — baked into the notification via terminal-notifier -execute,
     *  so clicks work even after the monitor process exits. */
    openUrl?: string;
}

const TERMINAL_NOTIFIER_CANDIDATES = ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"];

function findTerminalNotifier(): string | null {
    for (const path of TERMINAL_NOTIFIER_CANDIDATES) {
        if (existsSync(path)) {
            return path;
        }
    }

    return null;
}

/**
 * Fires notifications via `terminal-notifier -execute` so the click action is baked
 * into the notification at OS level — survives after the monitor process exits.
 * If terminal-notifier is missing, silently no-ops (notifications are nice-to-have).
 */
export class MonitorNotifier {
    private bin: string | null = null;
    private resolved = false;

    private ensure(): string | null {
        if (this.resolved) {
            return this.bin;
        }

        this.bin = findTerminalNotifier();
        this.resolved = true;

        if (!this.bin) {
            logger.debug("terminal-notifier not found — notifications will be skipped");
        }

        return this.bin;
    }

    async send(opts: SendOpts): Promise<void> {
        const bin = this.ensure();

        if (!bin) {
            return;
        }

        const args = [bin, "-title", opts.title, "-message", opts.body, "-group", opts.group];

        if (opts.subtitle) {
            args.push("-subtitle", opts.subtitle);
        }

        if (opts.sound) {
            args.push("-sound", opts.sound);
        }

        if (opts.openUrl) {
            args.push("-execute", `open -a "Brave Browser" "${opts.openUrl}"`);
        }

        try {
            Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
        } catch (error) {
            logger.debug(`Notification spawn failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    close(): void {
        // No listener to unsubscribe — clicks are baked into the notification.
    }
}
