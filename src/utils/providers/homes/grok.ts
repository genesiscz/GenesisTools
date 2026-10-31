import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { defaultWorkerHome } from "@genesiscz/utils/grok/worker-paths";
import type { NativeHomeLayout } from "../session-paths";

/** Grok's home: `GROK_HOME` or `~/.grok`, plus the headless worker home's sessions. */
export const homeLayout: NativeHomeLayout = {
    defaultFolder: ".grok",
    homeOverride: () => env.grok.getHomeOverride(),
    overrideVariable: "GROK_HOME",
    sessionRoots: (home) => {
        const grokHome = env.grok.getHomeOverride() ?? join(home, ".grok");
        const roots = [join(grokHome, "sessions")];
        const workerRoot = join(defaultWorkerHome(), "sessions");

        if (!roots.includes(workerRoot)) {
            roots.push(workerRoot);
        }

        return roots;
    },
    sessionRootsForHome: (providerHome) => [join(providerHome, "sessions")],
    isTranscript: (fileName) => fileName === "updates.jsonl",
    transcriptMaxDepth: 3,
    legacyRoots: () => [],
};
