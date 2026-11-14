import { ClaudeWorkerStore, claudeWorkerSourceHome } from "@app/claude/lib/worker/store";
import { claudePeerRoute, type HarnessAnswer, ownedWorkerRoute, ownedWorkers, t3ThreadRoute } from "../deliver";

/** Claude answers through an owned worker, then its own peer socket, then the T3 Code thread that runs it. */
export const harnessAnswer: HarnessAnswer = {
    routes: [ownedWorkerRoute("claude"), claudePeerRoute, t3ThreadRoute],
    ownedWorkers: () =>
        ownedWorkers({
            provider: "claude",
            label: "Claude",
            store: new ClaudeWorkerStore(),
            sourceHome: claudeWorkerSourceHome,
            started: (meta) => meta.turns > 0,
        }),
};
