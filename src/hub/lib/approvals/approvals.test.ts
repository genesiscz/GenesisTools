import { describe, expect, it } from "bun:test";
import { claudeRegistryDialog } from "@app/claude/lib/cmux/dialog-guard";
import type { CodexControl } from "@app/codex/lib/control";
import { claudePendingCall } from "@genesiscz/utils/agent-sessions/readers/claude-pending-call";
import { codexPendingCall } from "@genesiscz/utils/agent-sessions/readers/codex-pending-call";
import { grokPendingCall } from "@genesiscz/utils/agent-sessions/readers/grok-pending-call";
import type { PendingToolCall } from "@genesiscz/utils/agent-sessions/types";
import type { DialogKeyPress } from "@genesiscz/utils/agents/dialogs/keys";
import type { ClaudeLiveSession } from "@genesiscz/utils/claude/peer-message";
import { codexWorkerApprovals } from "./codex-worker";
import { answerPendingApproval, listPendingApprovals } from "./index";
import { type PaneFleetRow, paneApprovals } from "./pane";

const SESSION = "00000000-0000-4000-8000-000000000001";

describe("pending call readers", () => {
    it("claude: the newest tool_use with no tool_result, normalized", () => {
        const records = [
            {
                type: "assistant",
                cwd: "/work/shop",
                message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
            },
            { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] } },
            {
                type: "assistant",
                cwd: "/work/shop",
                timestamp: "2026-11-04T13:56:21.163Z",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "toolu_2",
                            name: "Bash",
                            input: { command: "curl -sS -o page.html https://example.com", description: "Download" },
                        },
                    ],
                },
            },
        ];

        expect(claudePendingCall(records)).toEqual({
            callId: "toolu_2",
            tool: "Bash",
            at: "2026-11-04T13:56:21.163Z",
            detail: {
                kind: "command",
                command: "curl -sS -o page.html https://example.com",
                cwd: "/work/shop",
                description: "Download",
            },
        });
        expect(claudePendingCall(records.slice(0, 2))).toBeNull();
    });

    it("claude: ExitPlanMode is a plan, Edit a file change", () => {
        const plan = claudePendingCall([
            {
                type: "assistant",
                message: {
                    content: [{ type: "tool_use", id: "t", name: "ExitPlanMode", input: { plan: "Step one" } }],
                },
            },
        ]);
        expect(plan?.detail).toEqual({ kind: "plan", plan: "Step one" });

        const edit = claudePendingCall([
            {
                type: "assistant",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "e",
                            name: "Edit",
                            input: { file_path: "/w/a.txt", old_string: "hello", new_string: "goodbye" },
                        },
                    ],
                },
            },
        ]);
        expect(edit?.detail).toEqual({
            kind: "file-change",
            changes: [{ path: "/w/a.txt", diff: "-hello\n+goodbye" }],
        });
    });

    it("codex: a code-mode exec call reads its cmd, an answered call is not pending", () => {
        const records = [
            { type: "turn_context", payload: { cwd: "/work/side" } },
            {
                type: "response_item",
                payload: {
                    type: "custom_tool_call",
                    call_id: "call_1",
                    name: "exec",
                    input: 'const r = await tools.exec_command({cmd:"touch probe.txt",sandbox_permissions:"require_escalated",justification:"May I?"});',
                },
            },
        ];

        expect(codexPendingCall(records)?.detail).toEqual({
            kind: "command",
            command: "touch probe.txt",
            cwd: "/work/side",
            description: "May I?",
        });
        expect(
            codexPendingCall([
                ...records,
                { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_1" } },
            ])
        ).toBeNull();
    });

    it("grok: the open tool_call with its rawInput", () => {
        const call = (id: string, sessionUpdate: string, extra: Record<string, unknown>) => ({
            params: { update: { sessionUpdate, toolCallId: id, ...extra } },
        });
        const records = [
            call("c1", "tool_call", {
                title: "run_terminal_command",
                rawInput: { command: "git commit --allow-empty -m probe" },
                _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } },
            }),
        ];

        expect(grokPendingCall(records)?.detail).toEqual({
            kind: "command",
            command: "git commit --allow-empty -m probe",
        });
        expect(grokPendingCall([...records, call("c1", "tool_call_update", { status: "completed" })])).toBeNull();
    });
});

describe("claude registry kind", () => {
    const entry: ClaudeLiveSession = {
        pid: 4242,
        sessionId: SESSION,
        name: null,
        cwd: null,
        status: "waiting",
        kind: "interactive",
        socketPath: "/tmp/none.sock",
        file: "/tmp/4242.json",
    };

    it("a permission prompt wait is a permission dialog, any other wait a decision", () => {
        expect(claudeRegistryDialog(SESSION, () => [{ ...entry, waitingFor: "permission prompt" }])?.kind).toBe(
            "permission"
        );
        expect(claudeRegistryDialog(SESSION, () => [{ ...entry, waitingFor: "input needed" }])?.kind).toBe("decision");
    });
});

function fleetEntry(): PaneFleetRow {
    return {
        provider: "claude",
        sessionId: SESSION,
        cwd: "/work/shop",
        transcript: { filePath: "/fake/transcript.jsonl" },
    };
}

function paneDeps(call: PendingToolCall | null, dialogKind: "permission" | "plan" | "decision" = "permission") {
    const pressed: DialogKeyPress[][] = [];
    return {
        pressed,
        deps: {
            fleet: async () => [fleetEntry()],
            openDialog: async () => ({ kind: dialogKind, question: null, signal: "registry" as const }),
            pendingCall: () => call,
            press: async (input: { presses: readonly DialogKeyPress[] }) => {
                pressed.push([...input.presses]);
                return { ref: "surface:9" };
            },
        },
    };
}

const BASH: PendingToolCall = { callId: "toolu_2", tool: "Bash", detail: { kind: "command", command: "curl x" } };
const PLAN: PendingToolCall = { callId: "toolu_3", tool: "ExitPlanMode", detail: { kind: "plan", plan: "Do it" } };

describe("pane approvals", () => {
    it("lists a permission dialog with its call and answers it with the measured keys", async () => {
        const { deps, pressed } = paneDeps(BASH);
        const source = paneApprovals(deps);
        const [approval] = await source.list();

        expect(approval.id).toBe(`pane|claude|${SESSION}|toolu_2`);
        expect(approval.dialog).toBe("permission");
        expect(approval.verdicts.allow).toEqual({ supported: true });

        const sources = {
            pane: source,
            "codex-worker": {
                list: async () => [],
                answer: async () => {
                    throw new Error("no");
                },
            },
        };
        const allow = await answerPendingApproval({ id: approval.id, verdict: "allow" }, sources);
        expect(allow.outcome).toBe("sent");
        expect(pressed[0]).toEqual([{ text: "1" }]);

        await answerPendingApproval({ id: approval.id, verdict: "deny", reason: "use the\nother host" }, sources);
        expect(pressed[1]).toEqual([{ key: "up" }, { key: "tab" }, { text: "use the other host" }, { key: "enter" }]);
    });

    it("refuses a changed call and a plan's allow-always, pressing nothing", async () => {
        const { deps, pressed } = paneDeps(PLAN, "permission");
        const source = paneApprovals(deps);
        const [plan] = await source.list();
        const target = { backend: "pane" as const, provider: "claude" as const, session: SESSION, callId: "toolu_3" };

        expect(plan.dialog).toBe("plan");
        expect(plan.verdicts["allow-always"].supported).toBe(false);
        expect((await source.answer(target, { id: plan.id, verdict: "allow-always" })).outcome).toBe("refused");
        expect(
            (await source.answer(target, { id: `pane|claude|${SESSION}|toolu_old`, verdict: "allow" })).outcome
        ).toBe("refused");
        expect(pressed).toEqual([]);
    });

    it("a dialog with no tool-call id refuses allow, so an old card cannot approve a later call", async () => {
        const { deps, pressed } = paneDeps(null, "permission");
        const source = paneApprovals(deps);
        const [approval] = await source.list();
        const target = { backend: "pane" as const, provider: "claude" as const, session: SESSION, callId: "unknown" };

        expect(approval.verdicts.allow.supported).toBe(false);
        expect(approval.verdicts["allow-always"].supported).toBe(false);
        expect(approval.verdicts.deny).toEqual({ supported: true });
        expect((await source.answer(target, { id: approval.id, verdict: "allow" })).outcome).toBe("refused");
        expect((await source.answer(target, { id: approval.id, verdict: "allow-always" })).outcome).toBe("refused");
        expect(pressed).toEqual([]);
        expect((await source.answer(target, { id: approval.id, verdict: "deny" })).outcome).toBe("sent");
    });

    it("a question dialog is not an approval", async () => {
        const { deps } = paneDeps(BASH, "decision");
        expect(await paneApprovals(deps).list()).toEqual([]);
    });
});

describe("codex worker approvals", () => {
    it("denies as the human with the reason, and refuses a request that is gone", async () => {
        const sent: Array<{ name: string; control: CodexControl }> = [];
        const source = codexWorkerApprovals({
            requests: () => [
                {
                    session: "work",
                    requestId: "req-7",
                    approval: {
                        rpcId: 7,
                        method: "item/commandExecution/requestApproval",
                        detail: "run",
                        command: "bun test",
                        cwd: "/work",
                        requestedAt: "2026-11-04T14:40:00.000Z",
                    },
                },
            ],
            control: async (name, control) => {
                sent.push({ name, control });
                return { ok: true };
            },
        });
        const sources = {
            pane: {
                list: async () => [],
                answer: async () => {
                    throw new Error("no");
                },
            },
            "codex-worker": source,
        };
        const [approval] = await listPendingApprovals(sources);

        expect(approval.detail).toEqual({ kind: "command", command: "bun test", cwd: "/work" });
        expect(
            (await answerPendingApproval({ id: approval.id, verdict: "deny", reason: "not now" }, sources)).outcome
        ).toBe("sent");
        expect(sent).toEqual([
            { name: "work", control: { op: "deny", requestId: "req-7", refusal: { by: "human", reason: "not now" } } },
        ]);
        expect(
            (await answerPendingApproval({ id: "codex-worker|codex|work|req-9", verdict: "allow" }, sources)).outcome
        ).toBe("refused");
    });
});
