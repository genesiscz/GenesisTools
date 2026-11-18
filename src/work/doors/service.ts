/**
 * The ONE adapter a TypeScript surface calls (work-items P7 decision 3): it opens a session of this process, calls the
 * library, runs the notifier after a write, and closes. It never spawns a CLI. The actions registry's `work` area
 * reaches it through the registered door (`registerWorkDoor`).
 */
import { spawnToolDetached } from "@genesiscz/utils/cli/tools";
import type { Reply } from "@genesiscz/utils/output/reply";
import { type WorkMethodName, workMethods } from "@genesiscz/utils/work/api";
import { registerWorkDoor, type WorkDoor, type WorkDoorCall } from "@genesiscz/utils/work/door";
import { callWork } from "@genesiscz/utils/work/handlers";
import { actorHere } from "../adapters/actor";
import { connectorsEnabled } from "../connectors";
import { openSession } from "../session";

const CONNECTOR_METHODS = new Set<string>(["pair", "unpair", "pull", "sync"]);

/** One call in this process. `quiet` is the CLI's choice: it prints the rule problems of the session; others do not. */
export async function callWorkHere(
    method: WorkMethodName,
    params: unknown,
    options: WorkDoorCall & { quiet?: boolean } = {}
): Promise<Reply<unknown>> {
    const read = workMethods[method].effect === "read";
    const opened = await openSession(
        {
            ...(options.request !== undefined ? { request: options.request } : {}),
            ...(options.dryRun === true ? { dryRun: true } : {}),
            ...(options.ownerSaid !== undefined ? { ownerSaid: options.ownerSaid } : {}),
        },
        // A read records no actor, so it skips the transcript read of the model facet (about 400 ms).
        { actor: actorHere({ model: !read }), quiet: options.quiet ?? true }
    );

    try {
        const reply = await callWork(method, params, opened.session);

        if (reply.ok && !read && options.dryRun !== true) {
            await opened.afterWrite();

            // The sync is a feed consumer: it runs after the commit, in its own process, so a write never waits
            // for the network (P5 decision 4). The connector methods push themselves.
            if (!CONNECTOR_METHODS.has(method) && connectorsEnabled(opened.session.ctx.rules?.layers ?? [])) {
                spawnToolDetached(["work", "sync"], { reparent: true });
            }
        }

        return reply;
    } finally {
        opened.close();
    }
}

export const workServiceDoor: WorkDoor = {
    call: (method, params, options) => callWorkHere(method, params, options),
};

/** Registers the door in this process; the genesis-tools tool calls it when it starts an action or the service. */
export function registerWorkServiceDoor(): void {
    registerWorkDoor(workServiceDoor);
}
