import { logger } from "@genesiscz/utils/logger";
import { removeNotifications } from "@genesiscz/utils/macos/notifications-app";
import { isTestProcess } from "@genesiscz/utils/test-process";

const log = logger.child({ component: "question:decision-banners" });

/** Stable per first row of a post, so a later retraction can find the banner. `isSafeNotificationId` accepts it. */
export function decisionNotificationId(row: { id: string }): string {
    return `qa-decision-${row.id}`;
}

type RemoveBanners = (notificationIds: string[]) => Promise<unknown>;

let remover: RemoveBanners | undefined;

/** A test passes a spy here; a test process never reaches the app's Notification Center otherwise. */
export function setDecisionBannerRemover(remove: RemoveBanners | undefined): void {
    remover = remove;
}

/**
 * Takes the banners of decisions that stopped waiting (answered, acknowledged, dismissed, superseded) out of
 * Notification Center. A banner's click opened the hub on a decision that was no longer waiting (2026-10-27: D26 of a
 * session, clicked 2 minutes after it was answered in chat). Best effort and never awaited by a write: without the app
 * the banner stays, and the hub's reveal says what became of the decision.
 */
export function retractDecisionBanners(ids: readonly string[]): void {
    if (ids.length === 0) {
        return;
    }

    const remove = remover ?? (isTestProcess() ? undefined : (list: string[]) => removeNotifications({ ids: list }));

    if (!remove) {
        return;
    }

    const notificationIds = ids.map((id) => decisionNotificationId({ id }));
    void remove(notificationIds)
        .then(() => log.debug({ ids: notificationIds }, "decision banners retracted"))
        .catch((error) => log.debug({ error, ids: notificationIds }, "could not retract decision banners"));
}
