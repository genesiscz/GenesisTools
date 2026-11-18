/** Builds the `WorkSession` of one call for a TypeScript door: the store, the caller, the rules and the ports. */
import type { Database } from "bun:sqlite";
import { spawnToolDetached } from "@genesiscz/utils/cli/tools";
import { logger, out } from "@genesiscz/utils/logger";
import type { CallOptions, WorkSession } from "@genesiscz/utils/work/handlers";
import type { Actor } from "@genesiscz/utils/work/model/item";
import { runNotifyOnce } from "@genesiscz/utils/work/notify";
import { projectRuleLoader } from "@genesiscz/utils/work/rules/load";
import { openWorkDb } from "@genesiscz/utils/work/store/db";
import { legacyHandoffs, sessionDelivery, t3Lineage } from "./adapters";
import { actorHere } from "./adapters/actor";
import { contextHere } from "./adapters/context";
import { inboxLine } from "./adapters/notify";
import { connectorPort, syncNeededAfter } from "./connectors";

const log = logger.child({ component: "work:session" });

export interface OpenedSession {
    session: WorkSession;
    /** Pass the journal position before a write to schedule sync for the projects it changed. */
    afterWrite(syncSince?: number): Promise<void>;
    close(): void;
}

export async function openSession(
    call: CallOptions = {},
    options: { db?: Database; actor?: { actor: Actor; project: string }; quiet?: boolean } = {}
): Promise<OpenedSession> {
    const { actor, project } = options.actor ?? actorHere();
    const db = options.db ?? openWorkDb();
    const loadRules = projectRuleLoader({ project, repoRoot: actor.repoRoot });
    const loaded = await loadRules({ project });

    if (!options.quiet) {
        for (const problem of loaded.problems) {
            out.printlnErr(`${problem.severity}: ${problem.code}: ${problem.message}`);
        }
    }

    const delivery = sessionDelivery();
    const session: WorkSession = {
        ctx: {
            db,
            actor,
            project,
            rules: loaded.rules,
            ports: {
                legacy: legacyHandoffs(),
                delivery,
                lineage: t3Lineage(),
                connectors: connectorPort(db, loadRules),
            },
        },
        call,
        loadRules,
        alive: async (sessionId, harness) => (await delivery.place(sessionId, harness))?.live ?? null,
        context: async (network) => (await contextHere({ actor, db, network })).report,
    };
    return {
        session,
        afterWrite: async (syncSince) => {
            try {
                await runNotifyOnce({ db, loadRules, inbox: inboxLine });
            } catch (error) {
                log.warn({ err: error }, "work notify: the pass failed; the next write runs it again");
            }

            try {
                if (syncSince !== undefined && (await syncNeededAfter({ db, seq: syncSince, loadRules }))) {
                    spawnToolDetached(["work", "sync"], { reparent: true });
                }
            } catch (error) {
                log.warn({ err: error }, "work sync: could not schedule a pass after the write");
            }
        },
        close: () => {
            if (options.db === undefined) {
                db.close();
            }
        },
    };
}
