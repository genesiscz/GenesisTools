import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import type { NativeHomeLayout } from "../session-paths";

/** Claude Code's home: `CLAUDE_CONFIG_DIR` or `~/.claude`, its transcripts under `projects/`. */
export const homeLayout: NativeHomeLayout = {
    defaultFolder: ".claude",
    homeOverride: () => env.paths.getClaudeConfigDir(),
    overrideVariable: "CLAUDE_CONFIG_DIR",
    sessionRoots: (home) => {
        const roots = [join(home, ".claude", "projects"), join(home, ".config", "claude", "projects")];
        const configDir = env.paths.getClaudeConfigDir();
        if (configDir) {
            const extra = join(configDir, "projects");
            if (!roots.includes(extra)) {
                roots.push(extra);
            }
        }
        return roots;
    },
    sessionRootsForHome: (providerHome) => [join(providerHome, "projects")],
    isTranscript: (fileName) => fileName.endsWith(".jsonl"),
    transcriptMaxDepth: 6,
    legacyRoots: () => [],
};
