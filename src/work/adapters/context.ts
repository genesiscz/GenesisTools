/** Builds the preflight context of the calling session from local facts (and the forge with `network`). */
import type { Database } from "bun:sqlite";
import { detectOrigin, originDriver } from "@genesiscz/utils/git/origins";
import { cachedPrForHead } from "@genesiscz/utils/git/origins/lookup-cache";
import { logger } from "@genesiscz/utils/logger";
import { type ContextReport, type ContextView, gatherContext, readBindings } from "@genesiscz/utils/work/context";
import type { Actor } from "@genesiscz/utils/work/model/item";
import { t3Lineage } from "./lineage";

const log = logger.child({ component: "agent-context" });

function gitHead(cwd: string): string | null {
    try {
        const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd, timeout: 5_000 });
        return result.exitCode === 0 ? result.stdout.toString().trim() : null;
    } catch (error) {
        log.debug({ err: error, cwd }, "agent-context: git rev-parse HEAD failed");
        return null;
    }
}

export async function contextHere({
    actor,
    db,
    network,
}: {
    actor: Actor;
    db: Database;
    network: boolean;
}): Promise<{ report: ContextReport; view: ContextView }> {
    const cwd = actor.repoRoot ?? process.cwd();
    const own = actor.sessionId !== null ? [actor.sessionId] : [];
    const leads = await t3Lineage().leadSessions({
        sessionId: actor.sessionId,
        parentThreadId: actor.host?.parentThreadId ?? null,
    });
    const origin = await detectOrigin(cwd);
    const head = gitHead(cwd);
    const view: ContextView = {
        actor,
        lineage: [...own, ...leads.filter((s) => !own.includes(s))],
        branch: actor.branch,
        head,
        originUrl: origin?.url ?? null,
        network,
        db,
        bindings: readBindings(actor.sessionId),
        fetchPr: async () => {
            const driver = await originDriver(cwd);

            if (driver === null || origin === null || actor.branch === null || head === null) {
                return null;
            }

            return (
                await cachedPrForHead({ driver, originUrl: origin.url, branch: actor.branch, head, maxAgeSeconds: 0 })
            ).pr;
        },
    };
    return { report: await gatherContext(view), view };
}
