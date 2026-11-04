import type { TimesheetWeekDto } from "@dd/contract";

// An invented week for the mock agent and the tests: tasks and work items are made up.
export const MOCK_TIMESHEET: TimesheetWeekDto = {
    timesheetId: 9001,
    periodStart: "2026-09-28",
    periodFinish: "2026-10-04",
    rows: [
        {
            task: "Shop checkout",
            code: "T-100",
            minutesByDay: { "2026-09-29": 240, "2026-09-30": 210 },
            totalMinutes: 450,
            clarityMinutes: 0,
            items: [{ workItemId: 5001, title: "Fix the basket total", minutes: 450 }],
        },
        {
            task: "Support",
            code: "T-200",
            minutesByDay: { "2026-10-01": 60 },
            totalMinutes: 60,
            clarityMinutes: null,
            items: [{ workItemId: 5002, title: "Answer a ticket", minutes: 60 }],
        },
    ],
    unmapped: [{ workItemId: 5003, minutes: 30 }],
    totalMinutes: 510,
    revision: "fixture-rev",
};
