import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { FRIDAY_REMINDER } from "@/features/timesheet/queries";

/**
 * The Friday reminder is a local weekly notification; whether it is scheduled is its own setting (on by default when
 * the screen first opens, off with the switch), so no other store holds it. Every function here answers the real
 * state and never rejects, so the screen's switch shows what is scheduled, not what was asked for.
 */
const DECIDED_ITEM = "dd_timesheet_reminder_decided";

/** On the first open the reminder is turned on, the default; after that the switch decides. */
export async function ensureDefaultReminder(): Promise<boolean> {
    try {
        if (!(await SecureStore.getItemAsync(DECIDED_ITEM))) {
            return await setReminder(true);
        }
    } catch (error) {
        console.warn("[timesheet] the Friday reminder default was not applied", error);
    }

    return reminderScheduled();
}

export async function reminderScheduled(): Promise<boolean> {
    try {
        const scheduled = await Notifications.getAllScheduledNotificationsAsync();
        return scheduled.some((entry) => entry.identifier === FRIDAY_REMINDER.id);
    } catch (error) {
        console.warn("[timesheet] scheduled notifications unreadable", error);
        return false;
    }
}

/** Whether this app may show notifications, asking once when iOS still lets it ask. */
async function notificationsAllowed(): Promise<boolean> {
    const current = await Notifications.getPermissionsAsync();

    if (current.granted || !current.canAskAgain) {
        return current.granted;
    }

    return (await Notifications.requestPermissionsAsync()).granted;
}

/**
 * Turns the Friday reminder on or off and answers whether it is scheduled now. The choice is recorded as decided only
 * once it took effect: a reminder that could not be scheduled (no notification permission, a scheduling error) stays
 * undecided, so the default turns it on again on a later open.
 */
export async function setReminder(on: boolean): Promise<boolean> {
    try {
        await Notifications.cancelScheduledNotificationAsync(FRIDAY_REMINDER.id).catch((error: unknown) => {
            console.warn("[timesheet] no Friday reminder to cancel", error);
        });

        if (on) {
            if (!(await notificationsAllowed())) {
                return false;
            }

            await Notifications.scheduleNotificationAsync({
                identifier: FRIDAY_REMINDER.id,
                content: {
                    title: "Timesheet",
                    body: "This week's Clarity hours are ready to review.",
                    data: { open: "/timesheet" },
                },
                trigger: {
                    type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
                    weekday: FRIDAY_REMINDER.weekday,
                    hour: FRIDAY_REMINDER.hour,
                    minute: FRIDAY_REMINDER.minute,
                },
            });
        }

        await SecureStore.setItemAsync(DECIDED_ITEM, "1");

        if (on) {
            // It was just scheduled. Off still reads the real state below: a failed cancel is only logged.
            return true;
        }
    } catch (error) {
        console.warn(`[timesheet] the Friday reminder was not turned ${on ? "on" : "off"}`, error);
    }

    return reminderScheduled();
}
