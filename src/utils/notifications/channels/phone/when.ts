import { awayFromDesk, type DeskPresence } from "@genesiscz/utils/macos/desk-presence";
import type { NotificationEvent, PhoneWhenConfig } from "../../types";

/** The defaults of `PhoneWhenConfig`: quiet while someone works at the Mac, through after 5 idle minutes. */
export const PHONE_WHEN_DEFAULTS = { desk: "away", idleMinutes: 5 } as const;

function minutesOf(clock: string): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Whether local `now` falls in `from`–`to` (a span past midnight wraps). An unreadable clock never holds. */
export function inQuietHours(quiet: { from: string; to: string }, now: Date): boolean {
    const from = minutesOf(quiet.from);
    const to = minutesOf(quiet.to);

    if (from === null || to === null || from === to) {
        return false;
    }

    const at = now.getHours() * 60 + now.getMinutes();
    return from < to ? at >= from && at < to : at >= from || at < to;
}

/**
 * Why the phone holds this alert, or null to send it. Quiet hours hold it unless it is time-sensitive; desk mode
 * `away` holds it while the Mac is in use. The presence is read only when desk mode needs it.
 */
export async function phoneHold({
    event,
    when = {},
    presence,
    now = new Date(),
}: {
    event: Pick<NotificationEvent, "timeSensitive">;
    when?: PhoneWhenConfig;
    presence: () => Promise<DeskPresence>;
    now?: Date;
}): Promise<string | null> {
    if (when.quiet && !event.timeSensitive && inQuietHours(when.quiet, now)) {
        return `quiet hours (${when.quiet.from}–${when.quiet.to})`;
    }

    const desk = when.desk ?? PHONE_WHEN_DEFAULTS.desk;

    if (desk === "always") {
        return null;
    }

    const idleMinutes = when.idleMinutes ?? PHONE_WHEN_DEFAULTS.idleMinutes;
    return awayFromDesk(await presence(), idleMinutes) ? null : `the Mac is in use (idle under ${idleMinutes} min)`;
}
