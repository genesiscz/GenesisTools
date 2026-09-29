import { buildQaDeepLink } from "@app/dev-dashboard/lib/qa-deep-link";
import { logger } from "@genesiscz/utils/logger";
import type { NotificationAction } from "@genesiscz/utils/macos/notifications";
import { removeNotifications } from "@genesiscz/utils/macos/notifications";
import { dispatchNotification } from "@genesiscz/utils/notifications";
import { summarizeForm } from "./render";
import type { AskForm } from "./types";

const log = logger.child({ component: "question:pending-notify" });

/**
 * Stable notification id for a form's banner, so it can be found again to retract or replace
 * it (`isSafeNotificationId` accepts it: no path separators, no `..`). Mirrors Genesis's
 * `QaNotificationRouter.notificationId(formId:)`.
 */
export function qaNotificationId(formId: string): string {
    return `qa-form-${formId}`;
}

enum BinaryPolarity {
    Yes = "yes",
    No = "no",
    None = "none",
}

const YES_HINTS = ["yes", "y", "accept", "ok", "true", "approve", "do it", "confirm"];
const NO_HINTS = ["no", "n", "reject", "cancel", "false", "deny", "skip", "abort"];

function matchesHint(label: string, hints: string[]): boolean {
    const trimmed = label.toLowerCase().trim();

    for (const hint of hints) {
        if (
            trimmed === hint ||
            trimmed.startsWith(`${hint} `) ||
            trimmed.startsWith(`${hint},`) ||
            trimmed.startsWith(`${hint}!`)
        ) {
            return true;
        }

        if (hint.includes(" ")) {
            if (trimmed.includes(hint)) {
                return true;
            }

            continue;
        }

        // A short token like "y"/"n" must match a whole WORD, never a substring of
        // "staging"/"production" — the exact failure mode Genesis's own comment calls out.
        if (hint.length >= 2 && trimmed.split(/[^a-z0-9]+/).includes(hint)) {
            return true;
        }
    }

    return false;
}

/** Same rule as Genesis's `QaNotificationRouter.polarity(of:)`. */
function polarity(label: string): BinaryPolarity {
    const isYes = matchesHint(label, YES_HINTS);
    const isNo = matchesHint(label, NO_HINTS);

    if (isYes && !isNo) {
        return BinaryPolarity.Yes;
    }

    if (isNo && !isYes) {
        return BinaryPolarity.No;
    }

    return BinaryPolarity.None;
}

/**
 * A single required item with exactly two choices of opposite yes/no polarity. Mirrors
 * Genesis's `QaNotificationRouter.isBinaryYesNo`; a staging/production pair does not qualify,
 * because neither label carries a polarity.
 */
export function isBinaryYesNo(form: AskForm): boolean {
    if (form.items.length !== 1) {
        return false;
    }

    const [item] = form.items;
    const choices = item.choices;

    if (choices?.length !== 2) {
        return false;
    }

    const a = polarity(choices[0].label);
    const b = polarity(choices[1].label);

    return (
        (a === BinaryPolarity.Yes && b === BinaryPolarity.No) || (a === BinaryPolarity.No && b === BinaryPolarity.Yes)
    );
}

/**
 * One button per choice on a detected binary yes/no form — clicking one answers the form
 * directly through the same path as `tools question answer`. The banner click itself already
 * opens the form (see {@link notifyPendingForm}'s own `open`), so a non-binary form gets no
 * buttons at all.
 */
export async function buildQaNotificationActions(form: AskForm): Promise<NotificationAction[]> {
    const actions: NotificationAction[] = [];

    if (isBinaryYesNo(form)) {
        const [item] = form.items;

        for (const choice of item.choices ?? []) {
            actions.push({
                id: `answer-${choice.id}`,
                title: choice.label,
                execute: `tools question answer ${form.id} --choice ${choice.id}`,
            });
        }
    }

    return actions;
}

/**
 * Deliver (or re-deliver) the "a question is waiting" banner for a pending form. Never throws:
 * the form is already persisted, so a banner that cannot be delivered must not lose the
 * question. Carries a stable {@link qaNotificationId} so {@link retractPendingNotification} can
 * find it again, and a (Yes…|No…) action button pair on a binary form.
 */
export async function notifyPendingForm(form: AskForm): Promise<void> {
    try {
        await dispatchNotification({
            app: "question",
            title: "A question is waiting for you",
            message: summarizeForm(form),
            open: await buildQaDeepLink(form.id),
            id: qaNotificationId(form.id),
            actions: await buildQaNotificationActions(form),
        });
    } catch (err) {
        log.warn({ err, id: form.id }, "could not notify about a pending form; the form itself is fine");
    }
}

/**
 * Remove a form's delivered or still-scheduled banner. Best effort: called once a form leaves
 * `pending` (answered, cancelled, timed out), whichever process resolves it, so a resolved
 * form's banner does not sit in Notification Center indefinitely (Genesis
 * `QaNotificationRouter.clear(formId:)`).
 */
export async function retractPendingNotification(formId: string): Promise<void> {
    try {
        await removeNotifications({ ids: [qaNotificationId(formId)] });
    } catch (err) {
        log.debug({ err, id: formId }, "could not retract the pending-form banner; it expires on its own");
    }
}
