import type { PendingCallDetail } from "@genesiscz/utils/agent-sessions/types";
import type { ApprovalDialogKind, ApprovalVerdict } from "@genesiscz/utils/agents/approvals/keys";
import type { HarnessId } from "@genesiscz/utils/harness/types";

export type { ApprovalDialogKind, ApprovalVerdict };

/**
 * Where a waiting tool call lives and how it is answered: a terminal pane's permission or plan dialog (keys through
 * cmux), or a `tools codex` worker's approval request (its control channel).
 */
export type ApprovalBackend = "pane" | "codex-worker";

/** Whether one verdict can be given, and why not. */
export type ApprovalVerdictSupport = { supported: true } | { supported: false; reason: string };

/** One tool call that waits for allow or deny, with exactly what it would do. */
export interface PendingApproval {
    /** `<backend>|<provider>|<session>|<call id>`: the answer names it, and a changed call refuses. */
    id: string;
    backend: ApprovalBackend;
    provider: HarnessId;
    /** The native session id (pane) or the worker session name (codex-worker). */
    session: string;
    /** The folder the session runs in, when known. */
    cwd: string | null;
    dialog: ApprovalDialogKind;
    tool: string;
    detail: PendingCallDetail;
    /** ISO time the call was written or the request was made. */
    askedAt: string | null;
    verdicts: Record<ApprovalVerdict, ApprovalVerdictSupport>;
}

export interface ApprovalAnswer {
    id: string;
    verdict: ApprovalVerdict;
    /** Words for the agent with a deny; ignored for an allow. */
    reason?: string;
}

/**
 * What became of an answer: `sent` (the keys were pressed, or the worker took the answer), `refused` (nothing was
 * sent, `detail` says why, the guard's own words), or `unknown` (a press or a request ran past its deadline and may
 * have landed: look before answering again).
 */
export interface ApprovalReceipt {
    id: string;
    verdict: ApprovalVerdict;
    outcome: "sent" | "refused" | "unknown";
    /** `cmux-keys`, `codex-control`, or `none`. */
    route: string;
    detail: string;
}

/** One backend's pending approvals: the table in `index.ts` holds one per `ApprovalBackend`. */
export interface ApprovalSource {
    list(): Promise<PendingApproval[]>;
    /** Answers one approval this source listed; the id was parsed into `target` by `parseApprovalId`. */
    answer(target: ApprovalTarget, answer: ApprovalAnswer): Promise<ApprovalReceipt>;
}

export interface ApprovalTarget {
    backend: ApprovalBackend;
    provider: HarnessId;
    session: string;
    callId: string;
}
