import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "@genesiscz/utils/async";
import { env } from "@genesiscz/utils/env";
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppDir } from "@genesiscz/utils/macos/genesis-app";
import {
    type GenesisAppRpcOutcome,
    genesisAppRpc,
    isGenesisAppRpcAvailable,
    isNotifyPostResult,
} from "@genesiscz/utils/macos/genesis-app-rpc";
import { escapeJxa } from "@genesiscz/utils/macos/jxa";
import { genesisAppBuildHint } from "@genesiscz/utils/macos/xcode";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
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

/** `find` over the rbenv tree may walk many gem directories; `which` and `-help` answer at once. */
const RBENV_SEARCH_TIMEOUT_MS = 5_000;
const NOTIFIER_PROBE_TIMEOUT_MS = 2_000;

/** The cached terminal-notifier path, when it still exists. Read-only, and an unreadable config means no cache. */
async function cachedTerminalNotifier(): Promise<string | null> {
    try {
        const cached = await storage.getConfigValue<string>("terminalNotifierPath");
        return cached && existsSync(cached) ? cached : null;
    } catch (error) {
        logger.debug({ error }, "terminal-notifier cache unreadable; searching instead");
        return null;
    }
}

/**
 * True when `candidate -help` exits 0 within the deadline. A binary that hangs is killed and counts as
 * unavailable, so neither `tools notify status` nor a fallback send can wait on it forever. A non-zero
 * exit counts as unavailable too: boundedCommand reports it in `status`, not `error`, and its
 * watchdog turns a binary that cannot be executed into exit 127.
 */
export async function probeTerminalNotifier(
    candidate: string,
    { timeoutMs = NOTIFIER_PROBE_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<boolean> {
    const result = await boundedCommand({ command: [candidate, "-help"], timeoutMs });

    if (result.error || result.status !== 0) {
        logger.debug(
            { candidate, status: result.status, error: result.error },
            "terminal-notifier candidate did not answer -help"
        );
        return false;
    }

    return true;
}

/**
 * Searches for the native terminal-notifier binary, bypassing rbenv shims: rbenv gem dirs,
 * homebrew, then PATH. Every subprocess has a deadline. Ignores the cache and writes nothing.
 */
async function searchTerminalNotifier(): Promise<string | null> {
    const candidates: string[] = [];

    // 1. Check rbenv gem paths
    const rbenvRoot = join(homedir(), ".rbenv", "versions");

    if (existsSync(rbenvRoot)) {
        const found = await boundedCommand({
            command: ["find", rbenvRoot, "-name", "terminal-notifier", "-path", "*/MacOS/*", "-type", "f"],
            timeoutMs: RBENV_SEARCH_TIMEOUT_MS,
        });

        if (found.error) {
            logger.debug({ error: found.error }, "rbenv search for terminal-notifier failed");
        } else {
            candidates.push(...found.stdout.trim().split("\n").filter(Boolean));
        }
    }

    // 2. Check homebrew
    for (const p of ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"]) {
        if (existsSync(p)) {
            candidates.push(p);
        }
    }

    // 3. Check PATH via `which` — but skip an rbenv shim
    const which = await boundedCommand({
        command: ["which", "terminal-notifier"],
        timeoutMs: NOTIFIER_PROBE_TIMEOUT_MS,
    });
    const whichPath = which.error ? "" : which.stdout.trim();

    if (whichPath && existsSync(whichPath)) {
        try {
            const content = await Bun.file(whichPath).text();

            if (!content.includes("RBENV") && !content.includes("rbenv")) {
                candidates.push(whichPath);
            }
        } catch (error) {
            logger.debug({ error, whichPath }, "could not read terminal-notifier on PATH");
        }
    }

    for (const candidate of candidates) {
        if (existsSync(candidate) && (await probeTerminalNotifier(candidate))) {
            return candidate;
        }
    }

    return null;
}

/**
 * The cached path, else a fresh search. Read-only, so a diagnostic (`tools notify status`) can call
 * it without writing the resolved path to the config cache.
 */
async function locateTerminalNotifier(): Promise<string | null> {
    return (await cachedTerminalNotifier()) ?? searchTerminalNotifier();
}

export interface ResolveTerminalNotifierDeps {
    readCache?: () => Promise<string | null | undefined>;
    writeCache?: (path: string) => Promise<void>;
    search?: () => Promise<string | null>;
}

/**
 * {@link locateTerminalNotifier} for a real send. A valid cached path is returned as it is, with no
 * config write. A path found by a search is cached best-effort: a config that cannot be written
 * costs the next send another search, never this notification.
 */
export async function resolveTerminalNotifier(deps: ResolveTerminalNotifierDeps = {}): Promise<string | null> {
    const readCache = deps.readCache ?? cachedTerminalNotifier;
    const cached = await readCache();

    if (cached && existsSync(cached)) {
        return cached;
    }

    const found = await (deps.search ?? searchTerminalNotifier)();

    if (found) {
        const writeCache = deps.writeCache ?? ((path: string) => storage.setConfigValue("terminalNotifierPath", path));

        try {
            await writeCache(found);
            logger.debug(`Resolved terminal-notifier: ${found}`);
        } catch (error) {
            logger.warn({ error, found }, "could not cache the terminal-notifier path; the next send searches again");
        }
    }

    return found;
}

interface SpawnResult {
    exitCode: number;
    stderr: string;
}

/** Injected for tests; the real spawn is the default. `signal` aborts when the send gives up, and must kill the child. */
export type SpawnTerminalNotifier = (args: string[], signal: AbortSignal) => Promise<SpawnResult>;

async function defaultSpawnTerminalNotifier(args: string[], signal: AbortSignal): Promise<SpawnResult> {
    const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe", signal });
    const [exitCode, stderrText] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { exitCode, stderr: stderrText };
}

/**
 * terminal-notifier answers in about 240 ms. One that has not exited by this deadline is stuck, and
 * waiting longer would hold every caller of `sendNotification` and keep the osascript fallback from
 * running, so the send counts as undelivered and the child is killed.
 */
const TERMINAL_NOTIFIER_TIMEOUT_MS = 5_000;

/**
 * Send a notification using terminal-notifier.
 *
 * `osascript -e 'display notification'` exits 0 even when macOS drops the notification, but
 * terminal-notifier does not: a missing notification permission fails loudly (exit 3,
 * "Could not request notification permission..."). #455 was GenesisTools ignoring that exit
 * code and still logging "Notification sent" — so a non-zero exit here is undelivered, not a
 * success, and the caller moves on to the next backend.
 */
export async function sendViaTerminalNotifier(
    bin: string,
    opts: NotificationOptions,
    {
        spawn = defaultSpawnTerminalNotifier,
        timeoutMs = TERMINAL_NOTIFIER_TIMEOUT_MS,
    }: { spawn?: SpawnTerminalNotifier; timeoutMs?: number } = {}
): Promise<boolean> {
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

    const giveUp = new AbortController();

    try {
        const { exitCode, stderr } = await withTimeout(
            spawn(args, giveUp.signal),
            timeoutMs,
            new Error(`terminal-notifier did not exit within ${timeoutMs} ms`)
        );

        if (exitCode !== 0) {
            logger.warn(
                `terminal-notifier failed to deliver (exit ${exitCode}): ${stderr.trim() || "no stderr"}. Fix: open System Settings > Notifications > terminal-notifier, or install GenesisTools.app (${genesisAppBuildHint()})`
            );
            return false;
        }

        return true;
    } catch (error) {
        giveUp.abort();
        logger.warn({ error }, "terminal-notifier failed to spawn or did not exit; trying the next backend");
        return false;
    }
}

/**
 * Send a notification using osascript as fallback. Fire-and-forget: osascript exits 0
 * whether or not macOS actually showed the banner, so this can never confirm delivery —
 * callers must not report it as "sent" (#455).
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
    const outcome = await genesisAppRpc(
        "notify.post",
        {
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
            replyDir: join(genesisAppDir(), "replies"),
            genesisHome: env.tools.getHome(),
        },
        { isResult: isNotifyPostResult }
    );

    if (outcome.ok) {
        return outcome.result.id;
    }

    if (outcome.error.code === "denied" || outcome.error.code === "not_determined") {
        // Falling through means another bundle delivers instead, so the user still gets the banner
        // and never learns the grant is missing. That is the documented contract for this function,
        // so the warning is how the problem stays visible.
        logger.warn(
            { error: outcome.error },
            outcome.error.code === "not_determined"
                ? "GenesisTools.app has never been granted notifications; run tools notify authorize. Falling back to terminal-notifier."
                : "GenesisTools.app may not post notifications; grant it in System Settings > Notifications. Falling back to terminal-notifier."
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
    /**
     * False for the osascript hand-off: it exits 0 whether or not macOS actually showed the
     * banner, so reaching it means no backend could confirm delivery (#455). `genesis-app`
     * and a zero-exit `terminal-notifier` both confirm and set this true.
     */
    confirmed: boolean;
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
                return { backend, id, confirmed: true };
            }

            continue;
        }

        if (backend === NotificationBackend.TerminalNotifier) {
            const bin = await resolveTerminalNotifier();

            if (bin && (await sendViaTerminalNotifier(bin, opts))) {
                logger.debug(`Notification sent via terminal-notifier: ${opts.message}`);
                return { backend, id: null, confirmed: true };
            }

            logger.debug("terminal-notifier unavailable or failed");
            continue;
        }

        // osascript — always-available terminal fallback, delivery cannot be confirmed from here.
        sendViaOsascript(opts);
        logger.debug(`Notification handed to osascript (delivery cannot be confirmed): ${opts.message}`);
        return { backend, id: null, confirmed: false };
    }

    // Unreachable in practice: osascript is always last and always runs. Kept so a future
    // reordering cannot silently return a backend that never ran.
    return { backend: NotificationBackend.Osascript, id: null, confirmed: false };
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
        replyDir: join(genesisAppDir(), "replies"),
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
 * ⚠️ The wait uses `watchFileFeed` (directory/file watch plus a poll fallback). bun 1.3.13 goes
 * deaf after the first `FSWatcher.close()` in a process; a watch without a poll sits out the
 * full timeout even though the user answered. The answer arrives from a process macOS launches,
 * minutes later, so this must not spin a tight loop while they think.
 */
export async function askNotification(
    opts: NotificationOptions,
    waitOpts: { timeoutMs?: number } = {}
): Promise<NotificationReply | null> {
    const replyDir = join(genesisAppDir(), "replies");
    mkdirSync(replyDir, { recursive: true });

    if (opts.id) {
        // A leftover reply for a reused id would satisfy the watch at once.
        rmSync(join(replyDir, `${opts.id}.json`), { force: true });
    }

    const posted = await postNotification(opts);

    if (posted.backend !== NotificationBackend.GenesisApp || !posted.id) {
        logger.debug({ backend: posted.backend }, "askNotification: only the genesis-app backend can carry a reply");
        return null;
    }

    const timeoutMs = waitOpts.timeoutMs ?? 5 * 60_000;
    const replyPath = join(replyDir, `${posted.id}.json`);
    await watchFileFeed({
        path: replyPath,
        deadlineAt: Date.now() + timeoutMs,
        debounceMs: 0,
        pollFallbackMs: 500,
        onChange: () => (existsSync(replyPath) ? { done: true } : undefined),
    });

    return readNotificationReply(posted.id, { consume: true });
}

/**
 * Send a macOS notification.
 *
 * Default backend chain: GenesisTools.app → terminal-notifier → osascript. Returns the same
 * {@link PostedNotification} as {@link postNotification} — check `.confirmed` before treating
 * this as "the user saw it" (#455): an osascript hand-off cannot confirm delivery.
 */
export async function sendNotification(opts: NotificationOptions): Promise<PostedNotification> {
    const posted = await postNotification(opts);

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

    return posted;
}

export type NotificationFallbackState =
    | { kind: "genesis-app" }
    | { kind: "terminal-notifier"; path: string }
    | { kind: "osascript-only" };

export interface ResolveNotificationFallbackStateDeps {
    isAppAvailable?: () => boolean;
    locateTerminalNotifier?: () => Promise<string | null>;
}

/**
 * Which backend would actually carry the next notification, for `tools notify status`
 * (#455 item 5): the GenesisTools.app RPC check alone used to report "unavailable" even
 * when terminal-notifier or osascript would still deliver. Read-only: never writes the
 * terminal-notifier path to the config cache the way a real send does.
 */
export async function resolveNotificationFallbackState(
    deps: ResolveNotificationFallbackStateDeps = {}
): Promise<NotificationFallbackState> {
    const isAppAvailable = deps.isAppAvailable ?? isGenesisAppRpcAvailable;

    if (isAppAvailable()) {
        return { kind: "genesis-app" };
    }

    const locate = deps.locateTerminalNotifier ?? locateTerminalNotifier;
    const path = await locate();

    if (path) {
        return { kind: "terminal-notifier", path };
    }

    return { kind: "osascript-only" };
}

/**
 * The launchd session this process runs in. Banners and permission prompts appear only in the
 * user's GUI login session ("Aqua"); an SSH or background session ("Background") never shows
 * them, whatever backend runs (#455). When the session cannot be read, this claims nothing.
 */
export function launchdSession(readManager: () => string | null = readLaunchdManagerName): {
    gui: boolean;
    manager: string | null;
} {
    const manager = readManager();

    return { gui: manager === null || manager === "Aqua", manager };
}

function readLaunchdManagerName(): string | null {
    if (process.platform !== "darwin") {
        return null;
    }

    try {
        const proc = Bun.spawnSync(["launchctl", "managername"], { stdout: "pipe", stderr: "pipe" });
        const name = proc.stdout.toString().trim();

        return proc.exitCode === 0 && name ? name : null;
    } catch (error) {
        logger.debug({ error }, "launchctl managername failed");
        return null;
    }
}

export interface NotificationCenterStatus {
    authorization: string;
    alertSetting: string;
    alertStyle: string;
    soundSetting: string;
    badgeSetting: string;
    notificationCenterSetting: string;
    lockScreenSetting: string;
    criticalAlertSetting: string;
    timeSensitiveSetting: string;
    bundleId: string;
    bundlePath: string;
    temporary: boolean;
    settingsUrl: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotificationCenterStatus(value: unknown): value is NotificationCenterStatus {
    return isObject(value) && typeof value.authorization === "string" && typeof value.temporary === "boolean";
}

export async function notificationStatus(): Promise<GenesisAppRpcOutcome<NotificationCenterStatus>> {
    return genesisAppRpc("notify.status", undefined, { isResult: isNotificationCenterStatus });
}

export async function authorizeNotifications(): Promise<GenesisAppRpcOutcome<Record<string, unknown>>> {
    return genesisAppRpc("notify.authorize", undefined, { timeoutMs: 120_000 });
}

export async function openNotificationSettings(): Promise<GenesisAppRpcOutcome<{ opened: string }>> {
    return genesisAppRpc("notify.settings", undefined, {
        isResult: (value: unknown): value is { opened: string } => isObject(value) && typeof value.opened === "string",
    });
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/** Notification ids become reply filenames. A path component would escape the reply directory. */
export function isSafeNotificationId(id: string): boolean {
    return id.length > 0 && !id.includes("/") && !id.includes("\\") && !id.includes("..");
}

function optionalBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function parseStringArray(value: unknown, field: string): string[] | { error: string } | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        return { error: `${field} must be an array of strings` };
    }

    return value;
}

function parseActions(value: unknown): NotificationAction[] | { error: string } | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value)) {
        return { error: "--payload.actions must be an array" };
    }

    const actions: NotificationAction[] = [];

    for (const item of value) {
        if (!isObject(item) || typeof item.id !== "string" || typeof item.title !== "string") {
            return { error: "--payload.actions[] needs string id and title" };
        }

        const action: NotificationAction = { id: item.id, title: item.title };
        const open = optionalString(item.open);

        if (open !== undefined) {
            action.open = open;
        }

        const execute = optionalString(item.execute);

        if (execute !== undefined) {
            action.execute = execute;
        }

        const destructive = optionalBoolean(item.destructive);

        if (destructive !== undefined) {
            action.destructive = destructive;
        }

        if (item.input !== undefined) {
            if (!isObject(item.input)) {
                return { error: "--payload.actions[].input must be an object" };
            }

            action.input = {
                buttonTitle: optionalString(item.input.buttonTitle),
                placeholder: optionalString(item.input.placeholder),
            };
        }

        actions.push(action);
    }

    return actions;
}

function parsePreferred(value: unknown): NotificationBackend | { error: string } | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (
        value === NotificationBackend.GenesisApp ||
        value === NotificationBackend.TerminalNotifier ||
        value === NotificationBackend.Osascript
    ) {
        return value;
    }

    return { error: "--payload.preferred must be genesis-app, terminal-notifier, or osascript" };
}

/** Narrow untrusted `--payload` JSON to {@link NotificationOptions} without a cast. */
export function parseNotificationOptions(
    value: unknown
): { ok: true; value: NotificationOptions } | { ok: false; error: string } {
    if (!isObject(value)) {
        return { ok: false, error: "--payload must be a JSON object" };
    }

    if (typeof value.message !== "string" || value.message.length === 0) {
        return { ok: false, error: "--payload needs at least a `message` field" };
    }

    const actions = parseActions(value.actions);

    if (actions && "error" in actions) {
        return { ok: false, error: actions.error };
    }

    const attachments = parseStringArray(value.attachments, "--payload.attachments");

    if (attachments && "error" in attachments) {
        return { ok: false, error: attachments.error };
    }

    const preferred = parsePreferred(value.preferred);

    if (preferred && typeof preferred === "object" && "error" in preferred) {
        return { ok: false, error: preferred.error };
    }

    const options: NotificationOptions = { message: value.message };
    const title = optionalString(value.title);

    if (title !== undefined) {
        options.title = title;
    }

    const subtitle = optionalString(value.subtitle);

    if (subtitle !== undefined) {
        options.subtitle = subtitle;
    }

    const sound = optionalString(value.sound);

    if (sound !== undefined) {
        options.sound = sound;
    }

    const group = optionalString(value.group);

    if (group !== undefined) {
        options.group = group;
    }

    const open = optionalString(value.open);

    if (open !== undefined) {
        options.open = open;
    }

    const execute = optionalString(value.execute);

    if (execute !== undefined) {
        options.execute = execute;
    }

    const appIcon = optionalString(value.appIcon);

    if (appIcon !== undefined) {
        options.appIcon = appIcon;
    }

    const id = optionalString(value.id);

    if (id !== undefined) {
        if (!isSafeNotificationId(id)) {
            return { ok: false, error: "--payload.id must not contain a path" };
        }

        options.id = id;
    }

    const ignoreDnD = optionalBoolean(value.ignoreDnD);

    if (ignoreDnD !== undefined) {
        options.ignoreDnD = ignoreDnD;
    }

    const say = optionalBoolean(value.say);

    if (say !== undefined) {
        options.say = say;
    }

    if (Array.isArray(actions)) {
        options.actions = actions;
    }

    if (Array.isArray(attachments)) {
        options.attachments = attachments;
    }

    if (typeof preferred === "string") {
        options.preferred = preferred;
    }

    return { ok: true, value: options };
}
