import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
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
import {
    isObject,
    type NotificationAppBackend,
    NotificationBackend,
    type NotificationOptions,
    type NotificationReply,
    postNotification,
} from "@genesiscz/utils/macos/notifications";
import { genesisAppBuildHint } from "@genesiscz/utils/macos/xcode";

/**
 * The GenesisTools.app side of notifications: the `genesis-app` backend (first in the chain, with the app's icon,
 * actions and replies), the hints that name the app, and what only the app can do (retract, list, ask, status,
 * authorize). notifications.ts loads this module by a run-time path, so a copy of the notification helpers without
 * it posts through terminal-notifier and osascript only and never mentions the app.
 */

/**
 * Post through GenesisTools.app, so the banner carries our icon and identity.
 * Returns the notification id, or null when the app could not take it and the chain should move on.
 */
export async function sendViaGenesisApp(opts: NotificationOptions): Promise<string | null> {
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
                ? `GenesisTools.app has never been granted notifications; run ${toolCommand("notify authorize")}. Falling back to terminal-notifier.`
                : "GenesisTools.app may not post notifications; grant it in System Settings > Notifications. Falling back to terminal-notifier."
        );
    }

    return null;
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

/** What notifications.ts asks of this module. */
export const appNotificationBackend: NotificationAppBackend = {
    available: isGenesisAppRpcAvailable,
    send: sendViaGenesisApp,
    terminalNotifierFixHint: () => `, or install GenesisTools.app (${genesisAppBuildHint()})`,
};
