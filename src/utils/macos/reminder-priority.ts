export type ReminderTodoPriority = "none" | "low" | "medium" | "high";

/** Apple Reminders priority integers (matches EventKit / darwinkit). */
export function formatReminderPriority(priority: number): string {
    if (priority === 1) {
        return "High";
    }

    if (priority === 5) {
        return "Medium";
    }

    if (priority === 9) {
        return "Low";
    }

    if (priority === 0) {
        return "None";
    }

    return `Priority ${priority}`;
}

export function reminderPriorityToTodo(priority: number): ReminderTodoPriority {
    if (priority === 1) {
        return "high";
    }

    if (priority === 5) {
        return "medium";
    }

    if (priority === 9) {
        return "low";
    }

    return "none";
}
