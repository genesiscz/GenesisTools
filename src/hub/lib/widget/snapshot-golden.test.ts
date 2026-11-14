import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRow } from "@app/ai/lib/sessions/agent-session-rows";
import { kitFixturePath } from "@app/macos/lib/kit-fixtures";
import type { DecisionRecord } from "@app/question/lib/decisions/store";
import type { AskForm } from "@app/question/lib/pending/types";
import type { QaRow } from "@app/question/lib/read-model";
import type { OpenQuestion } from "@genesiscz/utils/agents/dialogs/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { AgentsTree } from "../agents/types";
import { performWidgetAction } from "./actions";
import { type WidgetCard, type WidgetSources, widgetSnapshot } from "./snapshot";
import { mutateWidgetState } from "./storage";
import { type WidgetTarget, widgetPreferencesSchema, widgetSessionKey } from "./types";

/**
 * The golden widget snapshots in GenesisKitFixtures/Widget: what `widgetSnapshot` writes for a fixed, invented input
 * state. The kit's Swift tests decode the same files (`WidgetGoldenSnapshotTests`), so a field this builder renames
 * fails a test on each side instead of the running widget. A file that is not what the builder makes now fails here;
 * `GENESIS_TOOLS_WRITE_GOLDEN=1 bun run test src/hub/lib/widget/snapshot-golden.test.ts` writes them again.
 */
const WRITE_COMMAND = "GENESIS_TOOLS_WRITE_GOLDEN=1 bun run test src/hub/lib/widget/snapshot-golden.test.ts";

/** Every member of the card kind union; the type makes a new kind a compile error here until it is listed. */
const CARD_KINDS: Record<WidgetCard["kind"], true> = {
    decision: true,
    dialog: true,
    todo: true,
    form: true,
    answer: true,
    result: true,
};

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function minutesAgo(minutes: number): number {
    return NOW - minutes * 60_000;
}

function isoMinutesAgo(minutes: number): string {
    return new Date(minutesAgo(minutes)).toISOString();
}

const STAGED: WidgetTarget = {
    hostId: "local",
    provider: "codex",
    sessionId: "fixture-staged",
    sourceHome: "",
    cwd: "/fixture",
};
const WORK: WidgetTarget = {
    hostId: "local",
    provider: "claude",
    sessionId: "fixture-work",
    sourceHome: "",
    cwd: "/fixture/work",
};
const PERSONAL: WidgetTarget = {
    hostId: "local",
    provider: "codex",
    sessionId: "fixture-personal",
    sourceHome: "",
    cwd: "/fixture/personal",
};

function sessionRow(target: WidgetTarget, title: string, project: string, mtime: number): AgentSessionRow {
    return {
        provider: target.provider === "unknown" ? "claude" : target.provider,
        sessionId: target.sessionId,
        title,
        cwd: target.cwd,
        cwdShort: project,
        project,
        mtime,
        model: null,
        account: "work",
        filePath: `${target.cwd}/transcripts/${target.sessionId}.jsonl`,
    };
}

function decision(row: Partial<DecisionRecord> & Pick<DecisionRecord, "id" | "number" | "prompt">): DecisionRecord {
    return {
        sessionId: WORK.sessionId,
        provider: WORK.provider,
        cwd: WORK.cwd,
        project: "work",
        options: [],
        state: "open",
        createdTs: isoMinutesAgo(30),
        updatedTs: isoMinutesAgo(30),
        ...row,
    };
}

function answer(row: Partial<QaRow> & Pick<QaRow, "id" | "ts" | "question" | "answerMd">): QaRow {
    return {
        sessionId: WORK.sessionId,
        sessionTitle: "Work session",
        project: "work",
        repoRoot: WORK.cwd,
        cwd: WORK.cwd,
        branch: "main",
        commitSha: null,
        commitMessage: null,
        agent: "claude-code",
        isWorktree: false,
        worktreePath: null,
        aiAgent: null,
        agentLabel: null,
        tag: "question",
        refs: [],
        source: "mcp",
        turnUuid: null,
        supersededBy: null,
        readAt: null,
        ...row,
    };
}

/** One codex session with one open decision: the staging tests' session (`StagingFixture` in the kit tests). */
const stagedSources: WidgetSources = {
    sessions: async () => [sessionRow(STAGED, "Staged fixture", "Fixture", minutesAgo(5))],
    decisions: () => ({
        rows: [
            decision({
                id: "d1",
                sessionId: STAGED.sessionId,
                provider: STAGED.provider,
                cwd: STAGED.cwd,
                project: "Fixture",
                number: 7,
                prompt: "Keep it?",
                options: ["keep", "drop"],
                recommended: "a",
                createdTs: isoMinutesAgo(2),
                updatedTs: isoMinutesAgo(2),
            }),
        ],
        complete: true,
    }),
    forms: () => [],
    answers: () => [],
    agents: async () => ({ generatedAt: "", parents: [], orphans: [] }),
    inboxData: () => ({ answers: [], complete: true, truncated: false }),
    excerpts: (refs) => [...refs],
};

const WORK_DECISIONS: DecisionRecord[] = [
    decision({
        id: "d_1_fixture",
        number: 1,
        title: "Keep the compact layout?",
        prompt: "Keep the compact layout?\n\na) Keep it\nb) Go back to the wide layout",
        options: ["Keep it", "Go back to the wide layout"],
        recommended: "a",
        rationales: ["It fits the side panel", null],
        context: "The compact layout landed last week.",
        notes: "Either way the setting stays.",
        proposal: "Keep it and watch the feedback.",
        confidence: "high",
        blocking: true,
        refs: [{ path: "/fixture/work/src/layout.ts", line: 3 }],
    }),
    decision({
        id: "d_2_fixture",
        number: 2,
        prompt: "Which accounts get the new badge?",
        options: ["work", "personal", "both"],
        multiple: true,
        state: "drafted",
        draftOption: "ab",
        draft: "Start with these two.",
        createdTs: isoMinutesAgo(20),
        updatedTs: isoMinutesAgo(10),
    }),
    decision({
        id: "d_3_fixture",
        number: 3,
        prompt: "Ship on Friday?",
        options: ["yes", "no"],
        state: "acknowledged",
        option: "a",
        answer: "Yes, ship it.",
        answeredVia: "agent",
        answeredTs: isoMinutesAgo(15),
        comments: ["Shipped."],
        createdTs: isoMinutesAgo(40),
        updatedTs: isoMinutesAgo(15),
    }),
    decision({
        id: "d_4_fixture",
        number: 4,
        prompt: "Keep the wide layout?",
        options: ["yes", "no"],
        state: "superseded",
        supersededBy: "d_1_fixture",
        createdTs: isoMinutesAgo(50),
        updatedTs: isoMinutesAgo(30),
    }),
    decision({
        id: "t_5_fixture",
        type: "todo",
        number: 5,
        prompt: "Rename the fixture folder once the review lands.",
        createdTs: isoMinutesAgo(25),
        updatedTs: isoMinutesAgo(25),
    }),
];

const WORK_DIALOG: OpenQuestion = {
    provider: "claude",
    sessionId: WORK.sessionId,
    toolCallId: "toolu_fixture",
    kind: "decision",
    question: "Run the migration now?",
    options: ["Run it", "Wait"],
    questionCount: 1,
    askedAt: isoMinutesAgo(3),
    source: "hook",
};

const WORK_FORMS: AskForm[] = [
    {
        id: "form_pending_fixture",
        createdAt: minutesAgo(4),
        source: "Agent question",
        sessionHint: WORK.sessionId,
        projectPath: WORK.cwd,
        cwd: WORK.cwd,
        items: [
            {
                id: "q1",
                promptMarkdown: "Which account runs the nightly job?",
                choices: [
                    { id: "work", label: "work" },
                    { id: "personal", label: "personal" },
                ],
                allowFreeText: true,
                required: true,
            },
        ],
        status: "pending",
    },
    {
        id: "form_answered_fixture",
        createdAt: minutesAgo(60),
        source: "Agent question",
        sessionHint: WORK.sessionId,
        projectPath: WORK.cwd,
        cwd: WORK.cwd,
        items: [{ id: "q1", promptMarkdown: "Who reviews the change?", allowFreeText: true }],
        status: "answered",
        answers: { q1: { itemId: "q1", freeText: "alice@example.com" } },
        resolvedAt: minutesAgo(55),
        entryId: "qa_form_fixture",
    },
];

const WORK_ANSWERS: QaRow[] = [
    answer({
        id: "qa_answer_fixture",
        ts: minutesAgo(8),
        question: "Why the compact layout?",
        answerMd: "It fits the side panel without a scroll bar.",
        refs: [{ type: "file", value: "/fixture/work/src/layout.ts" }],
    }),
    answer({
        id: "qa_message_fixture",
        ts: minutesAgo(6),
        tag: "message",
        question: "The nightly job finished",
        answerMd: "The nightly job finished\n\nAll 12 steps passed.",
        readAt: minutesAgo(1),
    }),
];

const WORK_AGENTS: AgentsTree = {
    generatedAt: isoMinutesAgo(0),
    parents: [
        {
            sessionId: WORK.sessionId,
            provider: "claude",
            title: "Work session",
            project: "work",
            cwd: WORK.cwd,
            filePath: "/fixture/work/transcripts/fixture-work.jsonl",
            model: "fixture-model",
            account: "work",
            startedAt: isoMinutesAgo(90),
            lastAt: isoMinutesAgo(2),
            live: true,
            children: [
                {
                    id: "a1fixture",
                    harness: "claude",
                    kind: "background",
                    name: "reviewer",
                    description: "Review the layout change",
                    agentType: "general-purpose",
                    model: "fixture-model",
                    account: "work",
                    status: "completed",
                    startedAt: isoMinutesAgo(30),
                    lastAt: isoMinutesAgo(9),
                    toolCalls: 4,
                    unreadMail: 0,
                    team: null,
                    backendType: null,
                    filePath: "/fixture/work/transcripts/agent-a1fixture.jsonl",
                    spawnPrompt: null,
                    spawnPromptPreview: "Review the layout change and report the risks.",
                    toolUseId: "toolu_spawn_fixture",
                    spawnDepth: 1,
                    children: [],
                },
            ],
        },
    ],
    orphans: [],
};

/** Two sessions (work and personal) holding every kind of card the builder makes. */
const everyKindSources: WidgetSources = {
    sessions: async () => [
        sessionRow(WORK, "Work session", "work", minutesAgo(2)),
        sessionRow(PERSONAL, "Personal session", "personal", minutesAgo(45)),
    ],
    decisions: () => ({ rows: WORK_DECISIONS, complete: true }),
    dialogs: (provider, session) =>
        provider === WORK_DIALOG.provider && session === WORK.sessionId ? [WORK_DIALOG] : [],
    forms: (session) =>
        session === undefined
            ? WORK_FORMS.filter((form) => form.status === "pending")
            : WORK_FORMS.filter((form) => form.sessionHint === session),
    answers: (session) => (session === undefined || session === WORK.sessionId ? WORK_ANSWERS : []),
    agents: async () => WORK_AGENTS,
    inboxData: () => ({
        answers: [
            {
                id: "qa_answer_fixture",
                sessionId: WORK.sessionId,
                provider: "claude",
                title: "Work session",
                project: "work",
                cwd: WORK.cwd,
                at: minutesAgo(8),
                count: 1,
                itemTitle: "Why the compact layout?",
                itemTag: "question",
                afterClear: 1,
                recentAfterClear: 1,
                recentAfterClearTotal: 1,
            },
        ],
        complete: true,
        truncated: false,
    }),
    events: (ids) =>
        ids.includes("d_1_fixture")
            ? [{ id: "ev_fixture", sourceId: "d_1_fixture", at: minutesAgo(30), title: "DECISION 1 asked", body: "" }]
            : [],
    excerpts: (refs) => [...refs],
};

interface GoldenCase {
    /** The file in GenesisKitFixtures/Widget. */
    file: string;
    sources: WidgetSources;
    /** The session the widget shows; its cards (and its open dialogs) are in the snapshot. */
    selected?: WidgetTarget;
}

const GOLDEN: GoldenCase[] = [
    { file: "snapshot-staged-decision.json", sources: stagedSources, selected: STAGED },
    { file: "snapshot-selected-session.json", sources: everyKindSources, selected: WORK },
    { file: "snapshot-overview.json", sources: everyKindSources },
];

async function goldenText({ sources, selected }: GoldenCase): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "widget-golden-"));

    try {
        const selectedKey = selected ? widgetSessionKey(selected) : undefined;
        await mutateWidgetState(root, (state) => {
            state.selectedKey = selectedKey ?? null;
            // The change list reads the user's change log by session id; no fixture can stand in for it.
            state.preferences.showChanges = false;
        });
        const snapshot = await widgetSnapshot({ root, selectedKey, sources, now: NOW });
        return `${SafeJSON.stringify(snapshot, null, 4)}\n`;
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

function goldenPath(file: string): string {
    return kitFixturePath(file, "Widget");
}

/**
 * What the hub stores before anything is set. GenesisKit's `WidgetPreferences.hubDefaults` is the widget's copy for
 * the moment before its first snapshot, and `WidgetPreferencesStoreTests` holds it to this file.
 */
const DEFAULTS_FILE = "preferences-defaults.json";

function defaultsText(): string {
    return `${SafeJSON.stringify(widgetPreferencesSchema.parse({}), null, 4)}\n`;
}

describe("the golden widget snapshots", () => {
    it(`are what the snapshot builder writes now (rewrite them: ${WRITE_COMMAND})`, async () => {
        const stale: string[] = [];

        const files = [
            ...(await Promise.all(
                GOLDEN.map(async (golden) => ({ file: golden.file, text: await goldenText(golden) }))
            )),
            { file: DEFAULTS_FILE, text: defaultsText() },
        ];

        for (const { file, text } of files) {
            const path = goldenPath(file);

            if (env.test.shouldWriteGolden()) {
                writeFileSync(path, text);
                continue;
            }

            if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
                stale.push(file);
            }
        }

        expect(stale).toEqual([]);
    });

    it("hold every member of the card kind union at least once", () => {
        const seen = new Set<string>();

        for (const golden of GOLDEN) {
            const snapshot: { cards?: { kind?: unknown }[] } = SafeJSON.parse(
                readFileSync(goldenPath(golden.file), "utf8"),
                {
                    strict: true,
                }
            );

            for (const card of snapshot.cards ?? []) {
                seen.add(String(card.kind));
            }
        }

        expect(Object.keys(CARD_KINDS).filter((kind) => !seen.has(kind))).toEqual([]);
    });
});

describe("a preferences write from the widget", () => {
    it("is refused when it names a key the preferences do not have, and stores nothing", async () => {
        const root = await mkdtemp(join(tmpdir(), "widget-preferences-"));

        try {
            await expect(
                performWidgetAction({ root, input: { action: "preferences", patch: { inboxFiltre: "inbox" } } })
            ).rejects.toThrow(/inboxFiltre/);
            const stored = await performWidgetAction({
                root,
                input: { action: "preferences", patch: { inboxFilter: "inbox" } },
            });
            expect(stored).toMatchObject({ inboxFilter: "inbox" });
            expect(stored).not.toHaveProperty("inboxFiltre");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
