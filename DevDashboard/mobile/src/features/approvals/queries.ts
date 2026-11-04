import {
    type ApprovalAnswerInput,
    type ApprovalReceiptDto,
    type DashboardClient,
    ENDPOINTS,
    type PendingApprovalDto,
    type PendingApprovalsDto,
} from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

export const approvalsKeys = { list: ["approvals", "list"] as const };

/** A dialog holds the agent still, so the screen polls fast while it is on screen. */
export const APPROVALS_INTERVAL_MS = 5_000;

export function approvalsQuery(client: DashboardClient) {
    return queryOptions<PendingApprovalsDto>({
        queryKey: approvalsKeys.list,
        queryFn: () => client.call(ENDPOINTS.gatewayApprovals, {}),
        refetchInterval: APPROVALS_INTERVAL_MS,
    });
}

export function answerApproval(
    client: DashboardClient,
    input: ApprovalAnswerInput & { idempotencyKey: string }
): Promise<ApprovalReceiptDto> {
    const { idempotencyKey, ...body } = input;
    return client.call(ENDPOINTS.approvalsAnswer, body, { idempotencyKey });
}

export const DIALOG_LABELS: Readonly<Record<PendingApprovalDto["dialog"], string>> = {
    permission: "Permission",
    plan: "Plan",
};

export const BACKEND_LABELS: Readonly<Record<PendingApprovalDto["backend"], string>> = {
    pane: "terminal",
    "codex-worker": "codex worker",
};

/** "key sent in surface:12", or the refusal: the receipt line under the buttons. */
export function receiptLine(receipt: ApprovalReceiptDto): string {
    const head = receipt.outcome === "sent" ? "Sent" : receipt.outcome === "refused" ? "Refused" : "Unknown, check before retrying";
    return `${head}: ${receipt.detail}`;
}
