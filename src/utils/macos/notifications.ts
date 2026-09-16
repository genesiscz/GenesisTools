import { existsSync, mkdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppDir } from "@genesiscz/utils/macos/genesis-app";
import { genesisAppRpc, isGenesisAppRpcAvailable } from "@genesiscz/utils/macos/genesis-app-rpc";
import { escapeJxa } from "@genesiscz/utils/macos/jxa";
import { Storage } from "@genesiscz/utils/storage/storage";

export interface NotificationOptions {
    title?: string;
    message: string;
    subtitle?: string;
    sound?: string;
    group?: string;
    open?: string;
    execute?: string;
    appIcon?: string;
    /**
     * Image, audio or video files shown with the banner: a thumbnail on the right, and the first
     * one full size when the notification is expanded. Paths, `~` allowed.
     *
     * `genesis-app` only. The other backends ignore it. The app copies each file before attaching
     * it, because `UNNotificationAttachment` MOVES the file it is given out of its original place.
     */
    attachments?: string[];
    ignoreDnD?: boolean;
    say?: boolean;
    /**
     * Stable id, so the notification can be retracted later with {@link removeNotifications}, or
     * replaced in place by posting again with the same id. Generated when omitted.
     *
     * `genesis-app` only. The other backends ignore it.
     */
    id?: string;
    /**
     * Buttons on the banner, each with its own click action. The body click still uses the
     * top-level `open` / `execute`.
     *
     * `genesis-app` only. The other backends ignore it.
     */
    actions?: NotificationAction[];
    /**
     * Force a specific backend instead of the default chain (genesis-app → terminal-notifier → osascript).
     *
     * - `genesis-app`: posts from GenesisTools.app through UNUserNotificationCenter, so the banner carries
     *   the GenesisTools icon and identity. Click actions live in the notification's userInfo and macOS
     *   relaunches the bundle to run them, so they survive the sender exiting. Only backend with action
     *   buttons, retraction and listing.
     * - `terminal-notifier`: spawns the terminal-notifier binary (~240ms, bakes `-execute` into the
     *   notification at OS level so click actions survive sender exit, but shows ITS icon, not ours)
     * - `osascript`: uses macOS osascript fallback (no click actions, no grouping)
     *
     * If the preferred backend is unavailable (e.g. `terminal-notifier` not installed), falls through to
     * the next available backend automatically. Omit to use the default chain.
     */
    preferred?: NotificationBackend;
}

/** One button on a banner. `execute` runs first, then `open`. */
export interface NotificationAction {
    id: string;
    title: string;
    open?: string;
    execute?: string;
    /** Renders the button in red. Cosmetic only. */
    destructive?: boolean;
    /**
     * Turn this button into a text field. macOS shows an input box with a send button, and what the
     * user types comes back as {@link NotificationReply.text}.
     *
     * `genesis-app` only.
     */
    input?: { buttonTitle?: string; placeholder?: string };
}

/** What the user did with a notification, available long after the asking process has exited. */
export interface NotificationReply {
    id: string;
    /** The action's own id, or `com.apple.UNNotificationDefaultActionIdentifier` for a body click. */
    actionId: string;
    /** Only present when the action had an `input` field. */
    text?: string;
    /** ISO 8601, when the user answered. */
    at: string;
}

export enum NotificationBackend {
    GenesisApp = "genesis-app",
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
 * Post through GenesisTools.app, so the banner carries our icon and identity.
 * Returns the notification id, or null when the app could not take it and the chain should move on.
 */
async function sendViaGenesisApp(opts: NotificationOptions): Promise<string | null> {
    const outcome = await genesisAppRpc<{ id: string }>("notify.post", {
        message: opts.message,
        title: opts.title,
        subtitle: opts.subtitle,
        sound: opts.sound,
        group: opts.group,
        open: opts.open,
        execute: opts.execute,
        appIcon: opts.appIcon,
        attachments: opts.attachments,
        ignoreDnD: opts.ignoreDnD,
        id: opts.id,
        actions: opts.actions,
    });

    if (outcome.ok) {
        return outcome.result.id;
    }

    if (outcome.error.code === "denied") {
        // Falling through means another bundle delivers instead, so the user still gets the banner
        // and never learns the grant is missing. That is the documented contract for this function,
        // so the warning is how the problem stays visible.
        logger.warn(
            { error: outcome.error },
            "GenesisTools.app may not post notifications; grant it in System Settings > Notifications. Falling back to terminal-notifier."
        );
    }

    return null;
}

/**
 * Build the fall-through chain starting from the preferred backend.
 * Always ends with osascript so a notification is always delivered.
 */
function backendChain(preferred?: NotificationBackend): NotificationBackend[] {
    const all = [NotificationBackend.GenesisApp, NotificationBackend.TerminalNotifier, NotificationBackend.Osascript];

    if (!preferred) {
        return all;
    }

    return [preferred, ...all.filter((b) => b !== preferred)];
}

/** What {@link postNotification} delivered, and through which backend. */
export interface PostedNotification {
    backend: NotificationBackend;
    /** Only `genesis-app` returns one. The other backends cannot address a notification later. */
    id: string | null;
}

/**
 * Send a macOS notification and report which backend took it.
 *
 * Default backend chain: GenesisTools.app → terminal-notifier → osascript.
 * Override with `opts.preferred` to force a specific starting point — the chain still
 * falls through if the preferred backend is unavailable (e.g. `terminal-notifier` not
 * installed → osascript).
 *
 * Prefer {@link sendNotification} unless you need the id back to retract it later.
 */
export async function postNotification(opts: NotificationOptions): Promise<PostedNotification> {
    const chain = backendChain(opts.preferred);

    for (const backend of chain) {
        if (backend === NotificationBackend.GenesisApp) {
            if (!isGenesisAppRpcAvailable()) {
                logger.debug("GenesisTools.app unavailable; skipping the genesis-app backend");
                continue;
            }

            const id = await sendViaGenesisApp(opts);

            if (id) {
                logger.debug(`Notification sent via GenesisTools.app: ${opts.message}`);
                return { backend, id };
            }

            continue;
        }

        if (backend === NotificationBackend.TerminalNotifier) {
            const bin = await resolveTerminalNotifier();

            if (bin && sendViaTerminalNotifier(bin, opts)) {
                logger.debug(`Notification sent via terminal-notifier: ${opts.message}`);
                return { backend, id: null };
            }

            logger.debug("terminal-notifier unavailable or failed");
            continue;
        }

        // osascript — always-available terminal fallback
        sendViaOsascript(opts);
        logger.debug(`Notification sent via osascript: ${opts.message}`);
        return { backend, id: null };
    }

    // Unreachable in practice: osascript is always last and always "succeeds". Kept so a future
    // reordering cannot silently return a backend that never ran.
    return { backend: NotificationBackend.Osascript, id: null };
}

/**
 * Retract delivered notifications. Only notifications posted through GenesisTools.app can be
 * addressed, since the other backends post under a different bundle.
 *
 * Returns the ids actually removed, `"all"`, or null when the app is unavailable.
 */
export async function removeNotifications(target: {
    ids?: string[];
    group?: string;
    all?: boolean;
}): Promise<string[] | "all" | null> {
    const outcome = await genesisAppRpc<{ removed: string[] | "all" }>("notify.remove", target);

    if (!outcome.ok) {
        logger.debug({ error: outcome.error, target }, "Could not remove notifications");
        return null;
    }

    return outcome.result.removed;
}

export interface DeliveredNotification {
    id: string;
    title: string;
    subtitle: string;
    message: string;
    group: string;
    /** Seconds since the epoch. */
    deliveredAt: number;
}

/**
 * Notifications still in Notification Center, posted by GenesisTools.app. Null when unavailable.
 *
 * ⚠️ A notification does not appear here the instant {@link postNotification} resolves. `usernoted`
 * takes roughly a second to publish it, so a list taken straight after a post comes back without
 * it. Measured 2026-09-16: absent immediately, present after 1s. Do not use this to confirm a post.
 */
export async function listNotifications(): Promise<DeliveredNotification[] | null> {
    const outcome = await genesisAppRpc<{ notifications: DeliveredNotification[] }>("notify.list");

    if (!outcome.ok) {
        logger.debug({ error: outcome.error }, "Could not list notifications");
        return null;
    }

    return outcome.result.notifications;
}

/**
 * The answer to a notification, if the user has given one. Null when unanswered or unavailable.
 *
 * Non-blocking. Pass `consume` to delete the answer as you read it, so two callers cannot act on
 * the same reply.
 */
export async function readNotificationReply(
    id: string,
    opts: { consume?: boolean } = {}
): Promise<NotificationReply | null> {
    const outcome = await genesisAppRpc<{ answered: boolean } & NotificationReply>("notify.reply", {
        id,
        consume: opts.consume,
    });

    if (!outcome.ok || !outcome.result.answered) {
        return null;
    }

    return outcome.result;
}

/**
 * Ask a question in a notification and wait for the answer.
 *
 * Give one action an `input` field and the user gets a text box; give plain buttons and you learn
 * which was pressed. Resolves null on timeout, on a dismissed notification, or when the app is
 * unavailable — an unanswered question is a normal outcome, not an error.
 *
 * ⚠️ The wait is event-driven (`fs.watch` on the reply directory), never a poll. The answer arrives
 * minutes later from a process macOS launches, so a polling loop here would spin for the entire
 * time the user is thinking. See the busy-wait section in CLAUDE.md.
 */
export async function askNotification(
    opts: NotificationOptions,
    waitOpts: { timeoutMs?: number } = {}
): Promise<NotificationReply | null> {
    const posted = await postNotification(opts);

    if (posted.backend !== NotificationBackend.GenesisApp || !posted.id) {
        logger.debug({ backend: posted.backend }, "askNotification: only the genesis-app backend can carry a reply");
        return null;
    }

    const timeoutMs = waitOpts.timeoutMs ?? 5 * 60_000;
    const replyPath = join(genesisAppDir(), "replies", `${posted.id}.json`);
    await waitForFile(replyPath, timeoutMs);

    return readNotificationReply(posted.id, { consume: true });
}

/**
 * Resolve once `path` exists, or when the deadline passes. Never throws, never spins.
 *
 * Arms a `node:fs` watch on the parent directory instead of loading the `@parcel/watcher` addon
 * to wait for one file. The directory watch survives the app's write-temp-then-rename, which a
 * file-bound watcher does not. There is no debounce: a human answer should not sit in a buffer.
 */
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
    if (existsSync(path)) {
        return;
    }

    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });

    await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
            if (done) {
                return;
            }

            done = true;
            clearTimeout(timer);
            watcher.close();
            resolve();
        };

        const timer = setTimeout(finish, timeoutMs);
        const watcher = watch(dir, () => {
            if (existsSync(path)) {
                finish();
            }
        });
    });
}

/**
 * Send a macOS notification.
 *
 * Default backend chain: GenesisTools.app → terminal-notifier → osascript. Which one ran is not
 * reported: every caller gets a banner either way. Use {@link postNotification} when you need the
 * id back so you can retract it later.
 */
export async function sendNotification(opts: NotificationOptions): Promise<void> {
    await postNotification(opts);

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
