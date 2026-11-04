import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { FRIDAY_REMINDER } from "@/features/timesheet/queries";

/**
 * The Friday reminder is a local weekly notification; whether it is scheduled is its own setting (on by default when
 * the screen first opens, off with the switch), so no other store holds it.
 */
const DECIDED_ITEM = "dd_timesheet_reminder_decided";

/** On the first open the reminder is turned on, the default; after that the switch decides. */
export async function ensureDefaultReminder(): Promise<boolean> {
    if (!(await SecureStore.getItemAsync(DECIDED_ITEM))) {
        await setReminder(true);
    }

    return reminderScheduled();
}

export async function reminderScheduled(): Promise<boolean> {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    return scheduled.some((entry) => entry.identifier === FRIDAY_REMINDER.id);
}

export async function setReminder(on: boolean): Promise<void> {
    await SecureStore.setItemAsync(DECIDED_ITEM, "1");
    await Notifications.cancelScheduledNotificationAsync(FRIDAY_REMINDER.id).catch((error: unknown) => {
        console.warn("[timesheet] no Friday reminder to cancel", error);
    });

    if (!on) {
        return;
    }

    await Notifications.scheduleNotificationAsync({
        identifier: FRIDAY_REMINDER.id,
        content: { title: "Timesheet", body: "This week's Clarity hours are ready to review.", data: { open: "/timesheet" } },
        trigger: {
            type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
            weekday: FRIDAY_REMINDER.weekday,
            hour: FRIDAY_REMINDER.hour,
            minute: FRIDAY_REMINDER.minute,
        },
    });
}
