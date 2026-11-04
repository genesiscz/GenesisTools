import { KeyPressUnknownError, MessageError, pressDialogKeysInSurface } from "@app/ai/lib/agent-message/delivery";
import { sessionOpenDialog } from "@app/claude/lib/cmux/dialog-guard";
import { titleMatchKeys } from "@app/cmux/lib/title-match";
import type { PendingToolCall } from "@genesiscz/utils/agent-sessions/types";
import { planApprovalKeys } from "@genesiscz/utils/agents/approvals/keys";
import type { DialogKeyPress } from "@genesiscz/utils/agents/dialogs/keys";
import type { OpenDialog } from "@genesiscz/utils/agents/dialogs/types";
import { type FleetEntry, readFleetView } from "@genesiscz/utils/ai/live-sessions/fleet";
import { readPendingCall } from "@genesiscz/utils/ai/transcripts/pending-call";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { logger } from "@genesiscz/utils/logger";
import { approvalId } from "./id";
import type {
    ApprovalReceipt,
    ApprovalSource,
    ApprovalVerdict,
    ApprovalVerdictSupport,
    PendingApproval,
} from "./types";

const log = logger.child({ component: "hub/approvals" });

/** The fields of a fleet row the pane source reads. */
export type PaneFleetRow = Pick<FleetEntry, "provider" | "sessionId" | "cwd"> & {
    transcript: { filePath: string } | null;
};

/** The edges of the pane source; tests pass scripted ones. */
export interface PaneApprovalDeps {
    fleet(): Promise<PaneFleetRow[]>;
    openDialog(input: { sessionId: string; provider: HarnessId }): Promise<OpenDialog | null>;
    pendingCall(provider: HarnessId, transcriptPath: string): PendingToolCall | null;
    press(input: { alias: HarnessId; sessionId: string; presses: readonly DialogKeyPress[] }): Promise<{ ref: string }>;
}

export function livePaneApprovalDeps(): PaneApprovalDeps {
    return {
        fleet: () => readFleetView({ titleKeys: titleMatchKeys }),
        openDialog: sessionOpenDialog,
        pendingCall: readPendingCall,
        press: pressDialogKeysInSurface,
    };
}

function verdictsOf(provider: HarnessId, dialog: PendingApproval["dialog"]): PendingApproval["verdicts"] {
    const support = (verdict: ApprovalVerdict): ApprovalVerdictSupport => {
        const plan = planApprovalKeys({ provider, kind: dialog, verdict });
        return plan.ok ? { supported: true } : { supported: false, reason: plan.reason };
    };
    return { allow: support("allow"), "allow-always": support("allow-always"), deny: support("deny") };
}

/**
 * The pane approval of one live session, or null: the session shows a permission or plan dialog (the dialog guard's
 * signals: hook records, the transcript's turn state, Claude Code's registry), and its transcript's newest unanswered
 * call is what the dialog asks about (`NativeSessionReader.dialog.pendingCall`).
 */
async function paneApprovalOf(entry: PaneFleetRow, deps: PaneApprovalDeps): Promise<PendingApproval | null> {
    if (!entry.sessionId || !entry.transcript) {
        return null;
    }

    const dialog = await deps.openDialog({ sessionId: entry.sessionId, provider: entry.provider });

    if (!dialog || dialog.kind === "decision") {
        return null;
    }

    const call = deps.pendingCall(entry.provider, entry.transcript.filePath);
    const kind = call?.detail.kind === "plan" || dialog.kind === "plan" ? "plan" : "permission";
    const callId = call?.callId ?? dialog.toolCallId ?? "unknown";

    return {
        id: approvalId({ backend: "pane", provider: entry.provider, session: entry.sessionId, callId }),
        backend: "pane",
        provider: entry.provider,
        session: entry.sessionId,
        cwd: entry.cwd,
        dialog: kind,
        tool: call?.tool ?? "tool",
        detail: call?.detail ?? {
            kind: "tool",
            input: dialog.question ?? "the call's input is not in the transcript's tail; read it in the terminal",
        },
        askedAt: call?.at ?? null,
        verdicts: verdictsOf(entry.provider, kind),
    };
}

/** Pending approvals in terminal panes, answered by the harness's measured dialog keys through cmux. */
export function paneApprovals(deps: PaneApprovalDeps = livePaneApprovalDeps()): ApprovalSource {
    const list = async (): Promise<PendingApproval[]> => {
        const fleet = await deps.fleet();
        const found = await Promise.all(fleet.map((entry) => paneApprovalOf(entry, deps)));
        return found.filter((approval): approval is PendingApproval => approval !== null);
    };

    return {
        list,
        async answer(target, answer) {
            const refuse = (detail: string): ApprovalReceipt => ({
                id: answer.id,
                verdict: answer.verdict,
                outcome: "refused",
                route: "none",
                detail,
            });
            const now = (await list()).find(
                (approval) => approval.provider === target.provider && approval.session === target.session
            );

            if (!now) {
                return refuse("the session shows no permission or plan dialog any more; nothing was pressed");
            }

            if (now.id !== answer.id) {
                return refuse("the dialog now asks about another tool call; nothing was pressed. Read it again");
            }

            const plan = planApprovalKeys({
                provider: now.provider,
                kind: now.dialog,
                verdict: answer.verdict,
                reason: answer.reason,
            });

            if (!plan.ok) {
                return refuse(plan.reason);
            }

            try {
                const pressed = await deps.press({
                    alias: now.provider,
                    sessionId: now.session,
                    presses: plan.presses,
                });
                log.info({ id: answer.id, verdict: answer.verdict, ref: pressed.ref }, "approval keys pressed");
                return {
                    id: answer.id,
                    verdict: answer.verdict,
                    outcome: "sent",
                    route: "cmux-keys",
                    detail: `key sent in ${pressed.ref}`,
                };
            } catch (error) {
                if (error instanceof KeyPressUnknownError) {
                    return {
                        id: answer.id,
                        verdict: answer.verdict,
                        outcome: "unknown",
                        route: "cmux-keys",
                        detail: error.message,
                    };
                }

                if (error instanceof MessageError) {
                    return { ...refuse(error.message), route: "cmux-keys" };
                }

                throw error;
            }
        },
    };
}
