/**
 * Pending approvals (M9, F8): every tool call that waits for allow or deny, from `tools hub approvals`
 * (`src/hub/lib/approvals/`). Types only (`contract-purity.test.ts`); the hub's own types are not imported, so the
 * phone's `tsc` does not walk the hub, cmux and codex modules.
 */
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";

export type ApprovalVerdictDto = "allow" | "allow-always" | "deny";

export type ApprovalBackendDto = "pane" | "codex-worker";

export type ApprovalDialogDto = "permission" | "plan";

export interface ApprovalFileChangeDto {
    path: string;
    diff?: string;
    content?: string;
}

export type ApprovalDetailDto =
    | { kind: "command"; command: string; cwd?: string; description?: string }
    | { kind: "file-change"; changes: ApprovalFileChangeDto[] }
    | { kind: "plan"; plan: string }
    | { kind: "tool"; input: string };

export type ApprovalVerdictSupportDto = { supported: true } | { supported: false; reason: string };

export interface PendingApprovalDto {
    id: string;
    backend: ApprovalBackendDto;
    provider: AccountProviderAlias;
    session: string;
    cwd: string | null;
    dialog: ApprovalDialogDto;
    tool: string;
    detail: ApprovalDetailDto;
    askedAt: string | null;
    verdicts: Record<ApprovalVerdictDto, ApprovalVerdictSupportDto>;
}

/** `GET /api/gateway/approvals`. */
export interface PendingApprovalsDto {
    pending: PendingApprovalDto[];
}

/** `POST /api/approvals/answer`. */
export interface ApprovalAnswerInput {
    id: string;
    verdict: ApprovalVerdictDto;
    reason?: string;
}

/** `sent`: the keys were pressed or the worker took it; `refused`: nothing was sent; `unknown`: it may have landed. */
export interface ApprovalReceiptDto {
    id: string;
    verdict: ApprovalVerdictDto;
    outcome: "sent" | "refused" | "unknown";
    route: string;
    detail: string;
}
