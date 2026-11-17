/** Builds the `WorkSession` of one call for a TypeScript door: the store, the caller, the rules and the ports. */
import type { Database } from "bun:sqlite";
import { logger, out } from "@genesiscz/utils/logger";
import type { CallOptions, WorkSession } from "@genesiscz/utils/work/handlers";
import type { Actor } from "@genesiscz/utils/work/model/item";
import { runNotifyOnce } from "@genesiscz/utils/work/notify";
import { loadWorkRules } from "@genesiscz/utils/work/rules/load";
import { openWorkDb } from "@genesiscz/utils/work/store/db";
import { legacyHandoffs, sessionDelivery, t3Lineage } from "./adapters";
import { actorHere } from "./adapters/actor";
import { contextHere } from "./adapters/context";
import { inboxLine } from "./adapters/notify";
import { connectorPort } from "./connectors";

const log = logger.child({ component: "work:session" });

export interface OpenedSession {
    session: WorkSession;
    /** After a write: one notifier pass (P8 decision 3). It never fails the write; a failure is logged. */
    afterWrite(): Promise<void>;
    close(): void;
}

export async function openSession(
    call: CallOptions = {},
    options: { db?: Database; actor?: { actor: Actor; project: string }; quiet?: boolean } = {}
): Promise<OpenedSession> {
    const { actor, project } = options.actor ?? actorHere();
    const db = options.db ?? openWorkDb();
    const loaded = await loadWorkRules({ project, repoRoot: actor.repoRoot });

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
            ports: { legacy: legacyHandoffs(), delivery, lineage: t3Lineage(), connectors: connectorPort(db) },
        },
        call,
        alive: async (sessionId, harness) => (await delivery.place(sessionId, harness))?.live ?? null,
        context: async (network) => (await contextHere({ actor, db, network })).report,
    };
    return {
        session,
        afterWrite: async () => {
            try {
                const layers = loaded.rules.layers;
                await runNotifyOnce({ db, layers: () => layers, inbox: inboxLine });
            } catch (error) {
                log.warn({ err: error }, "work notify: the pass failed; the next write runs it again");
            }
        },
        close: () => {
            if (options.db === undefined) {
                db.close();
            }
        },
    };
}
