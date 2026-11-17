/** The inbox side of the notifier: a line at the level `inbox` or `banner` becomes one widget inbox message. */
// lint-rules-ignore: the notifier's port posts through the question tool's inbox message, the one door to the widget inbox
import { sendInboxMessage } from "@app/question/lib/message";
import { logger } from "@genesiscz/utils/logger";
import type { NotifyLine } from "@genesiscz/utils/work/notify";

const log = logger.child({ component: "work:notify" });

export async function inboxLine(line: NotifyLine): Promise<void> {
    // `inbox` stores the unread card quietly; `banner` also raises the notification and its sound.
    const result = await sendInboxMessage({
        interrupt: line.level === "banner",
        text: line.text,
        title: line.title,
        ...(line.sessionId !== null ? { sessionHint: line.sessionId } : {}),
        agentLabel: "work",
        source: "cli",
    });
    log.info({ item: line.item, action: line.action, level: line.level, message: result.id }, "work notify line sent");
}
