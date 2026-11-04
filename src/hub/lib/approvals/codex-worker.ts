import type { CodexControl } from "@app/codex/lib/control";
import { type ControlResponse, sendControlRequest } from "@app/codex/lib/control-channel";
import { isFileChangeApproval, listPendingRequests, type PendingRequest } from "@app/codex/lib/pending-approval";
import { CodexSessionStore } from "@app/codex/lib/store";
import type { PendingCallDetail } from "@genesiscz/utils/agent-sessions/types";
import { oneLine } from "@genesiscz/utils/agents/approvals/keys";
import { logger } from "@genesiscz/utils/logger";
import { WorkerDeliveryRejectedError } from "@genesiscz/utils/worker/delivery";
import { approvalId } from "./id";
import type { ApprovalReceipt, ApprovalSource, PendingApproval } from "./types";

const log = logger.child({ component: "hub/approvals" });

const ALLOW_ALWAYS_REFUSAL =
    "a tools codex worker's control channel answers one request; it has no allow-for-the-session answer";

/** The edges of the worker source; tests pass scripted ones. */
export interface CodexWorkerApprovalDeps {
    requests(): PendingRequest[];
    control(name: string, control: CodexControl): Promise<ControlResponse>;
}

export function liveCodexWorkerApprovalDeps(): CodexWorkerApprovalDeps {
    return {
        requests: () => listPendingRequests(new CodexSessionStore()),
        control: (name, control) => sendControlRequest(name, control),
    };
}

function detailOf(request: PendingRequest): PendingCallDetail {
    const { approval } = request;

    if (isFileChangeApproval(approval.method)) {
        const changes = (approval.changes ?? []).map((change) => ({
            path: change.movePath ? `${change.path} → ${change.movePath}` : change.path,
            ...(change.kind === "add" ? { content: change.diff ?? "" } : { diff: change.diff ?? `(${change.kind})` }),
        }));
        return changes.length > 0
            ? { kind: "file-change", changes }
            : { kind: "file-change", changes: (approval.paths ?? []).map((path) => ({ path })) };
    }

    if (approval.command) {
        return { kind: "command", command: approval.command, ...(approval.cwd ? { cwd: approval.cwd } : {}) };
    }

    return { kind: "tool", input: approval.detail };
}

function approvalOf(request: PendingRequest): PendingApproval {
    return {
        id: approvalId({
            backend: "codex-worker",
            provider: "codex",
            session: request.session,
            callId: request.requestId,
        }),
        backend: "codex-worker",
        provider: "codex",
        session: request.session,
        cwd: request.approval.cwd ?? null,
        dialog: "permission",
        tool: request.approval.method,
        detail: detailOf(request),
        askedAt: request.approval.requestedAt,
        verdicts: {
            allow: { supported: true },
            "allow-always": {
                supported: false,
                reason: ALLOW_ALWAYS_REFUSAL,
            },
            deny: { supported: true },
        },
    };
}

/**
 * A `tools codex` worker's approval requests, answered through its control channel as the human (settled for M9: a
 * person may answer an approval the lead was meant to answer; when the lead answered first, the worker refuses and the
 * receipt says so). A deny with words goes as a human refusal, so the worker reads who declined and why.
 */
export function codexWorkerApprovals(deps: CodexWorkerApprovalDeps = liveCodexWorkerApprovalDeps()): ApprovalSource {
    return {
        async list() {
            return deps.requests().map(approvalOf);
        },
        async answer(target, answer) {
            const receipt = (outcome: ApprovalReceipt["outcome"], detail: string): ApprovalReceipt => ({
                id: answer.id,
                verdict: answer.verdict,
                outcome,
                route: "codex-control",
                detail,
            });
            const open = deps
                .requests()
                .find((request) => request.session === target.session && request.requestId === target.callId);

            if (!open) {
                return receipt("refused", "nothing was sent: the request is no longer pending (answered or withdrawn)");
            }

            if (answer.verdict === "allow-always") {
                return receipt("refused", `nothing was sent: ${ALLOW_ALWAYS_REFUSAL}`);
            }

            const reason = answer.reason ? oneLine(answer.reason) : "";
            const control: CodexControl =
                answer.verdict === "allow"
                    ? { op: "approve", requestId: target.callId }
                    : {
                          op: "deny",
                          requestId: target.callId,
                          refusal: { by: "human", ...(reason ? { reason } : {}) },
                      };

            try {
                const response = await deps.control(target.session, control);

                if (!response.ok) {
                    return receipt("refused", response.error);
                }

                log.info({ id: answer.id, verdict: answer.verdict }, "codex worker approval answered");
                return receipt(
                    "sent",
                    answer.verdict === "allow"
                        ? "approved by the worker's control channel"
                        : "denied by the worker's control channel"
                );
            } catch (error) {
                if (error instanceof WorkerDeliveryRejectedError) {
                    return receipt("refused", `nothing was sent: ${error.message}`);
                }

                // A timeout after the request file was written: the worker may still take it.
                return receipt("unknown", error instanceof Error ? error.message : String(error));
            }
        },
    };
}
