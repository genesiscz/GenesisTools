import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAlive } from "@genesiscz/utils/process-alive";

export interface WorkerDeliveryExpectation {
    sessionId: string;
    sourceHome: string;
    afterTurn: number;
}

/** A refusal proven before the provider process can receive the prompt. */
export class WorkerDeliveryRejectedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkerDeliveryRejectedError";
    }
}

export function workerSourceHome(value: string): string {
    try {
        return realpathSync(value);
    } catch (error) {
        logger.debug({ error, path: value }, "Worker source home has no canonical filesystem path");
        return resolve(value);
    }
}

export function workerDeliveryExpectation(flags: Record<string, unknown>): WorkerDeliveryExpectation | undefined {
    if (flags.expectSession === undefined && flags.expectHome === undefined && flags.expectTurn === undefined) {
        return undefined;
    }
    const afterTurn = Number(flags.expectTurn);
    if (
        typeof flags.expectSession !== "string" ||
        !flags.expectSession.trim() ||
        typeof flags.expectHome !== "string" ||
        !flags.expectHome.trim() ||
        !Number.isInteger(afterTurn) ||
        afterTurn < 1
    ) {
        throw new WorkerDeliveryRejectedError(
            "A guarded delivery requires an exact session, source home and previous turn."
        );
    }
    return { sessionId: flags.expectSession, sourceHome: flags.expectHome, afterTurn };
}

export function assertWorkerDeliveryTarget({
    expected,
    sessionId,
    sourceHome,
    turns,
    sessionExists,
    activeTurn,
}: {
    expected?: WorkerDeliveryExpectation;
    sessionId: string;
    sourceHome: string;
    turns: number;
    sessionExists: boolean;
    activeTurn?: { ownerPid: number; childPid?: number };
}): void {
    if (!expected) {
        return;
    }
    if (sessionId !== expected.sessionId || workerSourceHome(sourceHome) !== workerSourceHome(expected.sourceHome)) {
        throw new WorkerDeliveryRejectedError("The worker session or source home changed; no prompt was sent.");
    }
    if (!sessionExists || turns !== expected.afterTurn) {
        throw new WorkerDeliveryRejectedError(
            "The worker turn changed or the original session has not started; no prompt was sent."
        );
    }
    if (
        activeTurn &&
        (isProcessAlive(activeTurn.ownerPid) || (activeTurn.childPid && isProcessAlive(activeTurn.childPid)))
    ) {
        throw new WorkerDeliveryRejectedError("The worker is busy; the answer remains queued for a later turn.");
    }
}
