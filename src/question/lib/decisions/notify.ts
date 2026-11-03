import { logger } from "@genesiscz/utils/logger";
import { dispatchNotification } from "@genesiscz/utils/notifications";
import { clipOneLine } from "@genesiscz/utils/string";
import { hubItemClickCommand } from "../hub-link";
import { waitsOnHuman } from "../waiting/set";
import { decisionNotificationId } from "./banners";
import { type DecisionRecord, kindOf } from "./store";

const log = logger.child({ component: "question:decision-notify" });

const MESSAGE_MAX = 220;

/**
 * Whether a posted row raises a banner: it is open (a stage never re-raises one) and the waiting set says it
 * waits for the human (`waitsOnHuman`: the `for` rule, no uncertain delivery).
 */
export function needsHuman(row: DecisionRecord): boolean {
    return row.state === "open" && waitsOnHuman(row);
}

function label(row: DecisionRecord): string {
    const head = `${kindOf(row) === "todo" ? "TODO" : "❓ DECISION"} ${row.number}`;
    return row.title ? `${head}: ${row.title}` : head;
}

/**
 * One banner for the rows of a post that wait for the human, sent only when GenesisTools.app is
 * installed: its click and its "Open in hub" button open the hub's Inbox at the first of them. Never
 * throws, because the rows are already stored and a banner that cannot go out must not fail the post.
 */
export async function notifyPostedDecisions(rows: DecisionRecord[], bundle?: string): Promise<boolean> {
    const waiting = rows.filter(needsHuman);

    if (waiting.length === 0) {
        log.debug({ rows: rows.length }, "no posted decision waits for the human; no banner");
        return false;
    }

    const [first] = waiting;
    const click = hubItemClickCommand("decision", first.id, bundle);

    if (!click) {
        log.debug({ id: first.id }, "GenesisTools.app is not installed; no decision banner");
        return false;
    }

    try {
        const where = first.project ?? first.sessionTitle;
        await dispatchNotification({
            app: "question",
            title: waiting.length === 1 ? label(first) : `${waiting.length} decisions wait for you`,
            subtitle: waiting.length === 1 ? where : `${label(first)}${where ? ` · ${where}` : ""}`,
            message: clipOneLine(first.prompt, MESSAGE_MAX),
            id: decisionNotificationId(first),
            execute: click,
            actions: [{ id: "open-hub", title: "Open in hub", execute: click }],
        });
        log.info({ ids: waiting.map((row) => row.id) }, "decision banner sent");
        return true;
    } catch (err) {
        log.warn({ err, id: first.id }, "could not notify about posted decisions; they are stored");
        return false;
    }
}
