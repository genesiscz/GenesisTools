import type { MemosDto } from "@dd/contract";

// An invented memo for the mock agent and the tests.
export const MOCK_MEMOS: MemosDto = {
    primedAt: "2026-09-30T08:00:00.000Z",
    memos: [
        {
            id: "12-1790000000000",
            memoId: 12,
            title: "Morning walk",
            recordedAt: "2026-10-01T07:10:00.000Z",
            transcript: "Buy coffee beans and book the dentist. The checkout test on the shop fails, have an agent look.",
            todos: ["Buy coffee beans", "Book the dentist"],
            note: "Walked the long loop; the idea for the shop banner came up again.",
            agentTask: "Find why the shop's checkout test fails and fix it.",
            done: {},
        },
    ],
};
