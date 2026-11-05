import { logger } from "@genesiscz/utils/logger";
import { codexWorkerApprovals } from "./codex-worker";
import { parseApprovalId } from "./id";
import { paneApprovals } from "./pane";
import type { ApprovalAnswer, ApprovalBackend, ApprovalReceipt, ApprovalSource, PendingApproval } from "./types";

export { parseApprovalId } from "./id";
export type * from "./types";

const log = logger.child({ component: "hub/approvals" });

export type ApprovalSources = Readonly<Record<ApprovalBackend, ApprovalSource>>;

/** One source per backend. A new backend (a Grok worker, a Codex TUI once its keys are measured) is one row here. */
export function liveApprovalSources(): ApprovalSources {
    return { pane: paneApprovals(), "codex-worker": codexWorkerApprovals() } satisfies ApprovalSources;
}

/**
 * Every tool call that waits for allow or deny, newest first. A source that fails is logged and left out, so one
 * broken backend never hides the others.
 */
export async function listPendingApprovals(
    sources: ApprovalSources = liveApprovalSources()
): Promise<PendingApproval[]> {
    const lists = await Promise.all(
        Object.entries(sources).map(async ([backend, source]) => {
            try {
                return await source.list();
            } catch (error) {
                log.warn({ error, backend }, "pending approvals of one backend could not be read");
                return [];
            }
        })
    );

    return lists.flat().sort((a, b) => (b.askedAt ?? "").localeCompare(a.askedAt ?? ""));
}

/** Answers one pending approval by its id, through the source that listed it. */
export async function answerPendingApproval(
    answer: ApprovalAnswer,
    sources: ApprovalSources = liveApprovalSources()
): Promise<ApprovalReceipt> {
    const target = parseApprovalId(answer.id);

    if (!target) {
        return {
            id: answer.id,
            verdict: answer.verdict,
            outcome: "refused",
            route: "none",
            detail: `"${answer.id}" is not an approval id`,
        };
    }

    const receipt = await sources[target.backend].answer(target, answer);
    log.info(
        { id: answer.id, verdict: answer.verdict, outcome: receipt.outcome, route: receipt.route },
        "approval answered"
    );
    return receipt;
}
