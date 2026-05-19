import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import type { DarwinKit } from "@app/utils/macos/darwinkit";
import { getDarwinKit } from "@app/utils/macos/darwinkit";
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
    /**
     * Force a specific backend instead of the default chain (darwinkit → terminal-notifier → osascript).
     *
     * - `darwinkit`: native UNUserNotificationCenter via DarwinKit (~90ms, supports onInteraction listener
     *   while sender is alive; click actions stored in user_info, lost when sender exits)
     * - `terminal-notifier`: spawns terminal-notifier binary (~240ms, bakes `-execute` into the notification
     *   at OS level so click actions survive sender exit)
     * - `osascript`: uses macOS osascript fallback (no click actions, no grouping)
     *
     * If the preferred backend is unavailable (e.g. `terminal-notifier` not installed), falls through to
     * the next available backend automatically. Omit to use the default chain.
     */
    preferred?: NotificationBackend;
}

export enum NotificationBackend {
    DarwinKit = "darwinkit",
    TerminalNotifier = "terminal-notifier",
    Osascript = "osascript",
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
    let dk: DarwinKit & {
        notifications?: { send(opts: Record<string, unknown>): Promise<void> };
    };

    try {
        dk = getDarwinKit() as DarwinKit & {
            notifications?: { send(opts: Record<string, unknown>): Promise<void> };
        };
    } catch (error) {
        logger.debug(`DarwinKit init failed: ${error instanceof Error ? error.message : error}`);
        return false;
    }

    if (!dk.notifications) {
        return false;
    }

    try {
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
 * Build the fall-through chain starting from the preferred backend.
 * Always ends with osascript so a notification is always delivered.
 */
function backendChain(preferred?: NotificationBackend): NotificationBackend[] {
    const all = [NotificationBackend.DarwinKit, NotificationBackend.TerminalNotifier, NotificationBackend.Osascript];

    if (!preferred) {
        return all;
    }

    return [preferred, ...all.filter((b) => b !== preferred)];
}

/**
 * Send a macOS notification.
 *
 * Default backend chain: DarwinKit → terminal-notifier → osascript.
 * Override with `opts.preferred` to force a specific starting point — the chain still
 * falls through if the preferred backend is unavailable (e.g. `terminal-notifier` not
 * installed → osascript).
 */
export async function sendNotification(opts: NotificationOptions): Promise<void> {
    const chain = backendChain(opts.preferred);

    for (const backend of chain) {
        if (backend === NotificationBackend.DarwinKit) {
            if (await sendViaDarwinKit(opts)) {
                logger.debug(`Notification sent via DarwinKit: ${opts.message}`);
                break;
            }

            continue;
        }

        if (backend === NotificationBackend.TerminalNotifier) {
            const bin = await resolveTerminalNotifier();

            if (bin && sendViaTerminalNotifier(bin, opts)) {
                logger.debug(`Notification sent via terminal-notifier: ${opts.message}`);
                break;
            }

            logger.debug("terminal-notifier unavailable or failed");
            continue;
        }

        // osascript — always-available terminal fallback
        sendViaOsascript(opts);
        logger.debug(`Notification sent via osascript: ${opts.message}`);
        break;
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
