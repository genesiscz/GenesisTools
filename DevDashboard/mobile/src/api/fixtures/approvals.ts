import type { PendingApprovalsDto } from "@dd/contract";

const ALL_VERDICTS = { allow: { supported: true }, "allow-always": { supported: true }, deny: { supported: true } } as const;

/** One pane permission prompt, one plan dialog and one codex worker file change. Invented fixtures only. */
export const MOCK_APPROVALS: PendingApprovalsDto = {
    pending: [
        {
            id: "pane|claude|00000000-0000-4000-8000-000000000001|toolu_mock_1",
            backend: "pane",
            provider: "claude",
            session: "00000000-0000-4000-8000-000000000001",
            cwd: "/Users/alice/projects/shop",
            dialog: "permission",
            tool: "Bash",
            detail: {
                kind: "command",
                command: "curl -sS -o page.html https://example.com",
                cwd: "/Users/alice/projects/shop",
                description: "Download the example page",
            },
            askedAt: "2026-11-04T14:56:21.000Z",
            verdicts: ALL_VERDICTS,
        },
        {
            id: "pane|claude|00000000-0000-4000-8000-000000000002|toolu_mock_2",
            backend: "pane",
            provider: "claude",
            session: "00000000-0000-4000-8000-000000000002",
            cwd: "/Users/alice/projects/side",
            dialog: "plan",
            tool: "ExitPlanMode",
            detail: { kind: "plan", plan: "Append the line world to notes.txt.\nRead the file back to check it." },
            askedAt: "2026-11-04T14:50:00.000Z",
            verdicts: {
                allow: { supported: true },
                "allow-always": {
                    supported: false,
                    reason: "the plan dialog's only other yes switches the whole session to bypass permissions; choose it in the terminal",
                },
                deny: { supported: true },
            },
        },
        {
            id: "codex-worker|codex|work|req-7",
            backend: "codex-worker",
            provider: "codex",
            session: "work",
            cwd: "/Users/alice/projects/work",
            dialog: "permission",
            tool: "item/fileChange/requestApproval",
            detail: { kind: "file-change", changes: [{ path: "src/app.ts", diff: "-const a = 1;\n+const a = 2;" }] },
            askedAt: "2026-11-04T14:40:00.000Z",
            verdicts: {
                allow: { supported: true },
                "allow-always": {
                    supported: false,
                    reason: "a tools codex worker's control channel answers one request; it has no allow-for-the-session answer",
                },
                deny: { supported: true },
            },
        },
    ],
};
