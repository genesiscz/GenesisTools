import { spawnSync } from "node:child_process";

function ensureMacOS(): void {
    if (process.platform !== "darwin") {
        throw new Error("Apple Reminders is only available on macOS");
    }
}

function runJxa(script: string, timeout = 15_000): string {
    const proc = spawnSync("osascript", ["-l", "JavaScript", "-e", script], {
        encoding: "utf-8",
        timeout,
    });

    if (proc.status !== 0) {
        throw new Error(`JXA error: ${proc.stderr?.trim() || "unknown error"}`);
    }

    return proc.stdout.trim();
}

function escapeJxa(str: string): string {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function ensureReminderListExists(name: string): void {
    ensureMacOS();

    const escapedName = escapeJxa(name);

    const script = `
const Reminders = Application("Reminders");
const lists = Reminders.lists.whose({name: "${escapedName}"});
if (lists.length === 0) {
    Reminders.List({name: "${escapedName}"}).make();
}
"ok";
`;

    runJxa(script);
}

export function createReminder(options: {
    title: string;
    notes?: string;
    dueDate?: Date;
    priority?: number;
    listName?: string;
}): string {
    ensureMacOS();

    const listName = options.listName ?? "GenesisTools";
    const escapedList = escapeJxa(listName);
    const escapedTitle = escapeJxa(options.title);
    const escapedNotes = options.notes ? escapeJxa(options.notes) : "";
    const priority = options.priority ?? 0;
    const dueDateMs = options.dueDate?.getTime();

    const dueDateLine = dueDateMs != null ? `dueDate: new Date(${dueDateMs}),` : "";

    const script = `
const Reminders = Application("Reminders");
const lists = Reminders.lists.whose({name: "${escapedList}"});
if (lists.length === 0) {
    Reminders.List({name: "${escapedList}"}).make();
}

const list = Reminders.lists.whose({name: "${escapedList}"})[0];
const reminder = Reminders.Reminder({
    name: "${escapedTitle}",
    body: "${escapedNotes}",
    ${dueDateLine}
    priority: ${priority}
});
list.reminders.push(reminder);
reminder.id();
`;

    return runJxa(script, 30_000);
}

export function completeReminder(options: { reminderId: string; listName?: string }): boolean {
    ensureMacOS();

    const listName = options.listName ?? "GenesisTools";
    const escapedList = escapeJxa(listName);
    const escapedId = escapeJxa(options.reminderId);

    const script = `
const Reminders = Application("Reminders");
const lists = Reminders.lists.whose({name: "${escapedList}"});
if (lists.length === 0) {
    "false";
} else {
    const list = lists[0];
    const reminders = list.reminders.whose({id: "${escapedId}"});
    if (reminders.length === 0) {
        "false";
    } else {
        reminders[0].completed = true;
        "true";
    }
}
`;

    const result = runJxa(script, 30_000);
    return result === "true";
}

export function deleteReminder(options: { reminderId: string; listName?: string }): boolean {
    ensureMacOS();

    const listName = options.listName ?? "GenesisTools";
    const escapedList = escapeJxa(listName);
    const escapedId = escapeJxa(options.reminderId);

    const script = `
const Reminders = Application("Reminders");
const lists = Reminders.lists.whose({name: "${escapedList}"});
if (lists.length === 0) {
    "false";
} else {
    const list = lists[0];
    const reminders = list.reminders.whose({id: "${escapedId}"});
    if (reminders.length === 0) {
        "false";
    } else {
        Reminders.delete(reminders[0]);
        "true";
    }
}
`;

    const result = runJxa(script, 30_000);
    return result === "true";
}

const PRIORITY_MAP: Record<string, number> = {
    critical: 1,
    high: 5,
    medium: 9,
    low: 0,
};

export function todoPriorityToApple(priority: "critical" | "high" | "medium" | "low"): number {
    return PRIORITY_MAP[priority];
}
