import { GrokSessionStore } from "@app/grok/lib/store";
import { grokLeaderRoute, type HarnessAnswer, ownedWorkerRoute, ownedWorkers } from "../deliver";

/** Grok answers through an owned worker, then the leader its TUI runs in. */
export const harnessAnswer: HarnessAnswer = {
    routes: [ownedWorkerRoute("grok"), grokLeaderRoute],
    ownedWorkers: () =>
        ownedWorkers({
            provider: "grok",
            label: "Grok",
            store: new GrokSessionStore(),
            sourceHome: (meta) => meta.workerHome,
            started: (meta) => meta.sessionStarted ?? (meta.turns > 0 && meta.lastTurn?.ended === true),
        }),
};
