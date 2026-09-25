import { resolve } from "node:path";
import { loadHooksConfig } from "@app/agents/lib/hooks/config";
import { isTaskRegistered, registerTask, unregisterTask } from "@app/daemon/lib/register";
import { logger } from "@genesiscz/utils/logger";
import { dispatchNotification } from "@genesiscz/utils/notifications";
import { shellCommandLine } from "@genesiscz/utils/shell/quote";
import { decisionFiles, staleCrossings } from "./read";
import { markNotified, readDecisions } from "./store";

const log = logger.child({ component: "question/stale" });

/** The daemon task behind `tools question stale --install`. */
export const STALE_TASK_NAME = "question-stale-decisions";
export const STALE_TASK_EVERY = "every 5 minutes";
const QUESTION_ENTRY = resolve(import.meta.dir, "../../index.ts");

export interface StaleReport {
    stale: Array<{ id: string; threshold: "warn" | "alarm"; ageMinutes: number }>;
    notified: boolean;
}

/**
 * Blocking decisions waiting past `decisions.staleness` in the agents hooks config. With `notify`
 * and the config's `notify` switch on, each new crossing raises one notification and is remembered,
 * so the next check does not raise it again.
 */
export async function checkStaleDecisions({ notify }: { notify: boolean }): Promise<StaleReport> {
    const { staleness } = loadHooksConfig().decisions;
    const { file, events } = decisionFiles();
    const crossings = staleCrossings(readDecisions(file), staleness);
    const notified = notify && staleness.notify;

    if (notified && crossings.length > 0) {
        for (const crossing of crossings) {
            try {
                await dispatchNotification({
                    app: "question",
                    title: `${crossing.threshold === "alarm" ? "Still waiting" : "Waiting"}: DECISION ${crossing.row.number}`,
                    message: `${crossing.row.title ?? crossing.row.prompt} (${crossing.ageMinutes} min)`,
                });
            } catch (error) {
                log.warn({ error, id: crossing.id }, "could not notify a stale decision");
            }
        }

        await markNotified(
            file,
            events,
            crossings.map((crossing) => ({ id: crossing.id, threshold: crossing.threshold }))
        );
    }

    log.debug({ stale: crossings.length, notified, staleness }, "stale decision check");

    return {
        stale: crossings.map(({ id, threshold, ageMinutes }) => ({ id, threshold, ageMinutes })),
        notified,
    };
}

/** Runs `tools question stale --notify` on a schedule, so the thresholds fire without anyone asking. */
export async function installStaleTask(): Promise<void> {
    await registerTask({
        name: STALE_TASK_NAME,
        command: shellCommandLine([Bun.which("bun") ?? "bun", "run", QUESTION_ENTRY, "stale", "--notify"]),
        every: STALE_TASK_EVERY,
        retries: 0,
        timeoutMs: 60_000,
        description: "Notify blocking decisions waiting past decisions.staleness (tools question stale)",
        overwrite: true,
        notify: false,
    });
}

export function uninstallStaleTask(): Promise<boolean> {
    return unregisterTask(STALE_TASK_NAME);
}

export function staleTaskInstalled(): Promise<boolean> {
    return isTaskRegistered(STALE_TASK_NAME);
}
