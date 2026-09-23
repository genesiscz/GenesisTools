import { logger } from "@genesiscz/utils/logger";
import { genesisAppRpc } from "@genesiscz/utils/macos/genesis-app-rpc";
import type { ApprovalDecision, ApprovalMethod, ClientIdentity, GateProvider, TokenKind } from "./types";

const { log } = logger.scoped("ai-gate");

/** A human has to read the window and touch the sensor; three minutes is generous, not lax. */
export const APPROVAL_TIMEOUT_MS = 180_000;

/** The choices the window offers. "Allow once" is 0; the rest remember for that long. */
export const REMEMBER_CHOICES_SECONDS = [0, 8 * 3600, 7 * 24 * 3600] as const;

export interface ApprovalRequest {
    client: ClientIdentity;
    provider: GateProvider;
    account: { id: string; name: string; label?: string };
    /** What the window says will be shared, decided before it opens. */
    tokenKind: TokenKind;
}

export type Approver = (request: ApprovalRequest) => Promise<ApprovalDecision>;

interface GateApproveReply {
    decision: "allow" | "deny";
    rememberSeconds?: number;
    method?: string;
    reason?: string;
}

function isGateApproveReply(value: unknown): value is GateApproveReply {
    return typeof value === "object" && value !== null && "decision" in value;
}

function asMethod(value: string | undefined): ApprovalMethod {
    return value === "touch-id" || value === "password" ? value : "none";
}

/**
 * Ask GenesisTools.app to show the approval window and run Touch ID.
 *
 * Every failure is a deny with a reason. The app being absent, a timeout, or a reply the client
 * cannot read must never fall through to "allowed": the gate exists to make a silent grant
 * impossible.
 */
export const appApprover: Approver = async (request) => {
    const outcome = await genesisAppRpc<GateApproveReply>(
        "gate.approve",
        {
            client: request.client,
            provider: request.provider,
            account: request.account,
            tokenKind: request.tokenKind,
            rememberChoicesSeconds: REMEMBER_CHOICES_SECONDS,
        },
        { timeoutMs: APPROVAL_TIMEOUT_MS, isResult: isGateApproveReply }
    );

    if (!outcome.ok) {
        log.warn({ error: outcome.error, client: request.client.name }, "approval window did not answer");
        return { decision: "deny", reason: `${outcome.error.code}: ${outcome.error.message}` };
    }

    if (outcome.result.decision !== "allow") {
        return { decision: "deny", reason: outcome.result.reason ?? "denied in the approval window" };
    }

    return {
        decision: "allow",
        rememberSeconds: Math.max(0, Math.floor(outcome.result.rememberSeconds ?? 0)),
        method: asMethod(outcome.result.method),
    };
};
