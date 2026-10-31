import { ClaudeWorkerStore, claudeWorkerSourceHome } from "@app/claude/lib/worker/store";
import { claudePeerRoute, type HarnessAnswer, ownedWorkerRoute, ownedWorkers } from "../deliver";

/** Claude answers through an owned worker, then its own peer socket. */
export const harnessAnswer: HarnessAnswer = {
    routes: [ownedWorkerRoute("claude"), claudePeerRoute],
    ownedWorkers: () =>
        ownedWorkers({
            provider: "claude",
            label: "Claude",
            store: new ClaudeWorkerStore(),
            sourceHome: claudeWorkerSourceHome,
            started: (meta) => meta.turns > 0,
        }),
};
