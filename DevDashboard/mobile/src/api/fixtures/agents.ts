import type { AgentsBoardDto, AgentTranscriptTurnDto } from "@dd/contract";

// Invented sessions for the mock agent and the tests: ids, projects, accounts and prompts are made up.
const NOW = Date.parse("2026-10-01T12:00:00Z");

const SAVED = { supported: true, meaning: "saved for this exact session until its consumer acknowledges it" } as const;

/** The Mac's per-harness timings (`src/hub/lib/send/senders`), as the board sends them. */
export const MOCK_SEND_TIMINGS: AgentsBoardDto["sendTimings"] = {
    claude: {
        now: { supported: true, meaning: "into the running session; a busy session reads it between tool calls" },
        "next-turn": {
            supported: false,
            reason: "Claude Code has no channel that holds a message until the turn ends: a message sent now is read between tool calls. Send it now, or later.",
        },
        later: SAVED,
    },
    codex: {
        now: { supported: true, meaning: "steered into the running turn through the session's worker" },
        "next-turn": { supported: true, meaning: "queued on the shared app-server; it runs after the current turn" },
        later: SAVED,
    },
    grok: {
        now: { supported: true, meaning: "into the running session through its worker or leader, else its cmux pane" },
        "next-turn": {
            supported: false,
            reason: "Grok has no measured channel that holds a message until the turn ends. Send it now, or later.",
        },
        later: SAVED,
    },
};

export const MOCK_BOARD: AgentsBoardDto = {
    generatedAt: new Date(NOW).toISOString(),
    sendTimings: MOCK_SEND_TIMINGS,
    sessions: [
        {
            key: "claude:aaaaaaaa-0000-4000-8000-000000000001",
            provider: "claude",
            sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
            phase: "tool",
            label: "stalled",
            stalled: true,
            stuck: { kind: "long-call", detail: "One tool call has run for 18 minutes." },
            pid: 41001,
            lastActivityAt: NOW - 18 * 60_000,
            project: "shop",
            cwd: "/work/shop",
            account: "work",
            model: "opus",
            title: "Checkout flow refactor",
            lastPrompt: "Run the checkout tests and fix what fails.",
            lastText: "Running the full test suite now.",
            children: [
                {
                    id: "a1",
                    harness: "claude",
                    kind: "background",
                    name: "Review the cart module",
                    model: "sonnet",
                    status: "running",
                    lastAt: new Date(NOW - 60_000).toISOString(),
                    liveLabel: null,
                    children: [],
                },
            ],
        },
        {
            key: "codex:bbbbbbbb-0000-4000-8000-000000000002",
            provider: "codex",
            sessionId: "bbbbbbbb-0000-4000-8000-000000000002",
            phase: "waiting",
            label: "waiting",
            stalled: false,
            stuck: null,
            pid: 41002,
            lastActivityAt: NOW - 3 * 60_000,
            project: "garden",
            cwd: "/work/garden",
            account: "personal",
            model: "gpt-5",
            title: "Plant database",
            lastPrompt: "Which schema should the plant table use?",
            lastText: "I need a decision before I migrate.",
            children: [],
        },
        {
            key: "grok:cccccccc-0000-4000-8000-000000000003",
            provider: "grok",
            sessionId: "cccccccc-0000-4000-8000-000000000003",
            phase: "thinking",
            label: "thinking",
            stalled: false,
            stuck: null,
            pid: 41003,
            lastActivityAt: NOW - 20_000,
            project: "notes",
            cwd: "/work/notes",
            account: null,
            model: "grok-4",
            title: null,
            lastPrompt: "Summarize this week's notes.",
            lastText: null,
            children: [],
        },
    ],
};

export const MOCK_TRANSCRIPT_TURNS: AgentTranscriptTurnDto[] = [
    { id: "t1", role: "user", at: new Date(NOW - 20 * 60_000).toISOString(), text: "Run the checkout tests and fix what fails.", tools: [] },
    {
        id: "t2",
        role: "assistant",
        at: new Date(NOW - 19 * 60_000).toISOString(),
        text: "Running the full test suite now.",
        tools: [{ id: "c1", name: "Bash", inputPreview: "bun run test src/checkout", result: null, isError: false }],
    },
];
