import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
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
    const escaped = (s: string) =>
        s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");

    const params = [
        `"${escaped(opts.message)}"`,
        opts.title ? `with title "${escaped(opts.title)}"` : "",
        opts.subtitle ? `subtitle "${escaped(opts.subtitle)}"` : "",
        `sound name "${escaped(opts.sound ?? "default")}"`,
    ]
        .filter(Boolean)
        .join(" ");

    Bun.spawn(["osascript", "-e", `display notification ${params}`], {
        stdout: "ignore",
        stderr: "ignore",
    });
}

/**
 * Send a macOS notification.
 * Primary: terminal-notifier (supports stacking, click actions, DnD bypass).
 * Fallback: osascript.
 */
export async function sendNotification(opts: NotificationOptions): Promise<void> {
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
