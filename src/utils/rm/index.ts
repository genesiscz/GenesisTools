import { userInfo } from "node:os";
import { gatherHarnessPoster } from "@genesiscz/utils/agent/runtime";
import { createTranscriptAnchor } from "@genesiscz/utils/agent/source-anchor";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { failureCaller } from "@genesiscz/utils/cli/failures/caller";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import type { RmConfig } from "./config";
import { isInside } from "./paths";
import { matchPreset } from "./presets";
import {
    evaluateTarget,
    type RmCaller,
    type RmRuleContext,
    type RmTarget,
    type RmVerdict,
    resolveTarget,
} from "./rules";
import { listBatches, type TrashPaths, trashHasEntries } from "./trash";

export * from "./approval";
export * from "./aside";
export * from "./config";
export * from "./ledger";
export * from "./paths";
export * from "./presets";
export * from "./profiles";
export * from "./requests";
export * from "./rules";
export * from "./trash";

export interface RmPlanItem {
    target: RmTarget;
    verdict: RmVerdict;
}

/**
 * The caller, stamped the way the question log stamps an answer (`gatherHarnessPoster`, the one poster stamp for
 * anything a harness posts, plus its transcript anchor): agent, session and title, project, checkout, branch and
 * commit. The model comes from the session's transcript, as the failures log reads it, and the operating-system user
 * names a person. A run outside any agent is a person.
 */
export function rmCallerFromRuntime(now = Date.now()): RmCaller {
    const processEnv = env.getProcessEnv();
    const poster = gatherHarnessPoster({}, processEnv);
    const details = poster.isInAgent ? failureCaller({ context: poster, processEnv }) : null;
    return {
        agent: poster.agent,
        sessionId: poster.sessionId,
        isInAgent: poster.isInAgent,
        sessionTitle: poster.sessionTitle,
        model: details?.model ?? null,
        project: poster.project,
        user: userInfo().username,
        aiAgent: poster.aiAgent,
        repoRoot: poster.repoRoot,
        branch: poster.branch,
        commitSha: poster.commitSha,
        worktreePath: poster.worktreePath,
        transcriptAnchor: createTranscriptAnchor({ context: poster, receivedAt: now }),
    };
}

/**
 * A verdict for each input. Duplicates collapse, and a path inside an input that is allowed is dropped, since
 * moving that folder moves it too. A path inside a refused or asked-about input keeps its own verdict.
 */
export function planRemoval(inputs: readonly string[], ctx: RmRuleContext): RmPlanItem[] {
    const plan: RmPlanItem[] = [];

    for (const input of inputs) {
        const target = resolveTarget(input, ctx.cwd);

        if (plan.some((item) => item.target.canonical === target.canonical)) {
            continue;
        }

        plan.push({ target, verdict: evaluateTarget(target, ctx) });
    }

    return plan.filter(
        (item) =>
            !plan.some(
                (outer) =>
                    outer.verdict.kind === "allow" &&
                    outer.target.kind === "dir" &&
                    isInside(item.target.canonical, outer.target.canonical)
            )
    );
}

/**
 * Minutes a moved item waits before the drain. A folder a preset matches (a build or an install recreates it) gets
 * the preset grace whichever rule allowed it, e.g. a node_modules in the session's scratch; the rest waits longer.
 */
export function graceMinutesFor(item: RmPlanItem, ctx: RmRuleContext, override?: number): number {
    if (override !== undefined) {
        return override;
    }

    const isPreset =
        item.verdict.rule === "preset" ||
        (item.target.kind === "dir" && matchPreset(item.target.path, ctx.presets) !== null);
    return isPreset ? ctx.config.grace.presetMinutes : ctx.config.grace.otherMinutes;
}

/**
 * Starts the background drainer when a batch waits or the trash holds an orphan from a run that died; a running
 * drainer makes the new one exit at once. Every `tools rm` run calls it, so leftovers never pile up.
 */
export function kickDrainer(config: RmConfig, paths?: TrashPaths): void {
    if (listBatches(paths).length === 0 && !trashHasEntries(config)) {
        return;
    }

    const pid = spawnToolDetached(["rm", "drain", "--background"], { reparent: true });
    logger.debug({ pid }, "rm: drainer started");
}
