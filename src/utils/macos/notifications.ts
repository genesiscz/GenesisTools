import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import type { DarwinKit } from "@app/utils/macos/darwinkit";
import { getDarwinKit, hasDarwinKit } from "@app/utils/macos/darwinkit";
import { escapeJxa } from "@app/utils/macos/jxa";
import { Storage } from "@app/utils/storage/storage";

export interface NotificationOptions {
    title?: string;
    message: string;
    subtitle?: string;
    sound?: string;
    group?: string;
    open?: string;
    execute?: string;
    appIcon?: string;
    ignoreDnD?: boolean;
    say?: boolean;
    /** DarwinKit-exclusive: action buttons via registered category */
    categoryIdentifier?: string;
    /** DarwinKit-exclusive: notification attachments (file paths) */
    attachments?: string[];
}

const storage = new Storage("notify");

/**
 * Resolve the native terminal-notifier binary path, bypassing rbenv shims.
 * Checks rbenv gem dirs, homebrew, then PATH. Caches the result.
 */
async function resolveTerminalNotifier(): Promise<string | null> {
    const cached = await storage.getConfigValue<string>("terminalNotifierPath");

    if (cached && existsSync(cached)) {
        return cached;
    }

    const candidates: string[] = [];

    // 1. Check rbenv gem paths
    const rbenvRoot = join(homedir(), ".rbenv", "versions");

    if (existsSync(rbenvRoot)) {
        try {
            const proc = Bun.spawn(
                ["find", rbenvRoot, "-name", "terminal-notifier", "-path", "*/MacOS/*", "-type", "f"],
                { stdout: "pipe", stderr: "ignore" }
            );
            const output = await new Response(proc.stdout).text();
            await proc.exited;

            const paths = output.trim().split("\n").filter(Boolean);
            candidates.push(...paths);
        } catch {
            // rbenv search failed, continue
        }
    }

    // 2. Check homebrew
    const brewPaths = ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"];

    for (const p of brewPaths) {
        if (existsSync(p)) {
            candidates.push(p);
        }
    }

    // 3. Check PATH via `which` — but verify it's not a shim
    try {
        const proc = Bun.spawn(["which", "terminal-notifier"], {
            stdout: "pipe",
            stderr: "ignore",
        });
        const whichPath = (await new Response(proc.stdout).text()).trim();
        await proc.exited;

        if (whichPath && existsSync(whichPath)) {
            // Check if it's a shim by reading the first few bytes
            const content = await Bun.file(whichPath).text();
            const isShim = content.includes("RBENV") || content.includes("rbenv");

            if (!isShim) {
                candidates.push(whichPath);
            }
        }
    } catch {
        // which failed
    }

    // Pick the first valid candidate
    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            try {
                // Verify it's executable
                const proc = Bun.spawn([candidate, "-help"], {
                    stdout: "ignore",
                    stderr: "ignore",
                });
                await proc.exited;

                await storage.setConfigValue("terminalNotifierPath", candidate);
                logger.debug(`Resolved terminal-notifier: ${candidate}`);
                return candidate;
            } catch {}
        }
    }

    return null;
}

/**
 * Send a notification using terminal-notifier.
 * Returns true if successful.
 */
function sendViaTerminalNotifier(bin: string, opts: NotificationOptions): boolean {
    const args = [bin, "-message", opts.message];

    if (opts.title) {
        args.push("-title", opts.title);
    }

    if (opts.subtitle) {
        args.push("-subtitle", opts.subtitle);
    }

    if (opts.sound) {
        args.push("-sound", opts.sound);
    }

    if (opts.group) {
        args.push("-group", opts.group);
    }

    if (opts.open) {
        args.push("-open", opts.open);
    }

    if (opts.execute) {
        args.push("-execute", opts.execute);
    }

    if (opts.appIcon) {
        args.push("-appIcon", opts.appIcon);
    }

    if (opts.ignoreDnD) {
        args.push("-ignoreDnD");
    }

    try {
        Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
        return true;
    } catch {
        return false;
    }
}

/**
 * Send a notification using osascript as fallback.
 */
function sendViaOsascript(opts: NotificationOptions): void {
    const params = [
        `"${escapeJxa(opts.message)}"`,
        opts.title ? `with title "${escapeJxa(opts.title)}"` : "",
        opts.subtitle ? `subtitle "${escapeJxa(opts.subtitle)}"` : "",
        `sound name "${escapeJxa(opts.sound ?? "default")}"`,
    ]
        .filter(Boolean)
        .join(" ");

    Bun.spawn(["osascript", "-e", `display notification ${params}`], {
        stdout: "ignore",
        stderr: "ignore",
    });
}

/**
 * Try sending via DarwinKit's native UNUserNotificationCenter bridge.
 * Returns true if successful, false if darwinkit is unavailable or fails.
 */
async function sendViaDarwinKit(opts: NotificationOptions): Promise<boolean> {
    if (!hasDarwinKit()) {
        return false;
    }

    try {
        const dk = getDarwinKit() as DarwinKit & {
            notifications?: { send(opts: Record<string, unknown>): Promise<void> };
        };

        if (!dk.notifications) {
            return false;
        }

        await dk.notifications.send({
            title: opts.title ?? "GenesisTools",
            body: opts.message,
            subtitle: opts.subtitle,
            sound: opts.sound ? { named: opts.sound } : "default",
            thread_identifier: opts.group,
            category_identifier: opts.categoryIdentifier,
            attachments: opts.attachments,
            user_info: {
                ...(opts.open ? { open: opts.open } : {}),
                ...(opts.execute ? { execute: opts.execute } : {}),
            },
        });
        return true;
    } catch (error) {
        logger.debug(`DarwinKit notification failed: ${error instanceof Error ? error.message : error}`);
        return false;
    }
}

/**
 * Send a macOS notification.
 * Primary: DarwinKit native UNUserNotificationCenter (full feature support).
 * Secondary: terminal-notifier (supports stacking, click actions, DnD bypass).
 * Fallback: osascript.
 */
export async function sendNotification(opts: NotificationOptions): Promise<void> {
    // Try DarwinKit first (native UNUserNotificationCenter)
    const sentViaDarwinKit = await sendViaDarwinKit(opts);

    if (sentViaDarwinKit) {
        logger.debug(`Notification sent via DarwinKit: ${opts.message}`);
    } else {
        // Fall back to terminal-notifier / osascript
        const bin = await resolveTerminalNotifier();

        if (bin) {
            const sent = sendViaTerminalNotifier(bin, opts);

            if (sent) {
                logger.debug(`Notification sent via terminal-notifier: ${opts.message}`);
            } else {
                logger.debug("terminal-notifier failed, falling back to osascript");
                sendViaOsascript(opts);
            }
        } else {
            logger.debug("terminal-notifier not found, using osascript fallback");
            sendViaOsascript(opts);
        }
    }

    if (opts.say) {
        try {
            Bun.spawn(["tools", "say", opts.message], {
                stdout: "ignore",
                stderr: "ignore",
            });
        } catch {
            logger.debug("tools say failed for notification TTS");
        }
    }
}
