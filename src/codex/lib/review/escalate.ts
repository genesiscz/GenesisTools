import { logger } from "@genesiscz/utils/logger";
import type { EscalateReviewRequest } from "../session";
import { type LaunchConfig, spawnCodexSession } from "../spawn";
import type { CodexReviewConfig } from "./types";

const log = logger.child({ component: "codex:review-escalate" });

const FALLBACK_PROMPT = "Review the change between the base and HEAD that the manifest lists.";

/**
 * The review record of the escalated session: the same base, manifest and prompt one tier higher, at step 2 so
 * its own miss ends the chain `shallow`. Its verdict, reason and spend start empty.
 */
export function escalatedReview(
    review: CodexReviewConfig,
    request: Pick<EscalateReviewRequest, "effort" | "meta">
): CodexReviewConfig {
    return {
        base: review.base,
        baseSource: review.baseSource,
        baseDetail: review.baseDetail,
        ...(review.branch ? { branch: review.branch } : {}),
        ...(review.pr === undefined ? {} : { pr: review.pr }),
        manifest: review.manifest,
        effort: request.effort,
        effortSource: "flag",
        allowShallow: review.allowShallow,
        step: 2,
        chain: review.chain,
        parent: request.meta.name,
        ...(review.prompt ? { prompt: review.prompt } : {}),
    };
}

/**
 * Starts the escalated review from inside the daemon: the same cwd, home, account, write policy, swarm and
 * writable roots as the session that missed, under the name the gate recorded. A steer cannot change a running
 * thread's effort, which is why the higher tier needs a new session.
 */
export async function escalateCodexReview(request: EscalateReviewRequest, launch: LaunchConfig): Promise<void> {
    const { meta } = request;

    if (!meta.review) {
        throw new Error(`${meta.name} is not a review session`);
    }

    const review = escalatedReview(meta.review, request);
    log.info({ from: meta.name, to: request.name, effort: request.effort }, "starting the escalated review");

    await spawnCodexSession({
        name: request.name,
        cwd: meta.cwd,
        ...(meta.home ? { home: meta.home } : {}),
        ...(meta.model ? { model: meta.model } : {}),
        ...(launch.accountId ? { account: launch.accountId } : {}),
        ...(launch.computerUse ? { computerUse: true } : {}),
        ...(launch.project ? { project: launch.project } : {}),
        ...(meta.label ? { label: meta.label } : {}),
        write: meta.writePolicy,
        mode: "review",
        agents: meta.agentsEnabled,
        rendezvousSession: meta.rendezvousSession,
        writableRoots: launch.writableRoots,
        prompt: review.prompt ?? FALLBACK_PROMPT,
        review,
    });
}
