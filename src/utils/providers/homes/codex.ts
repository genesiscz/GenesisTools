import { join } from "node:path";
import { codexHomeOverrides, codexHomesIn, type NativeHomeLayout, primaryCodexHome } from "../session-paths";

/** Codex CLI 0.164 compresses its old rollouts to `rollout-….jsonl.zst` (single-frame zstd). */
const CODEX_COMPRESSED_SUFFIX = ".jsonl.zst";

/** Codex's home: the primary `CODEX_HOME` or `~/.codex`, its rollouts under `sessions/` and `archived_sessions/`. */
export const homeLayout: NativeHomeLayout = {
    defaultFolder: ".codex",
    homeOverride: () => primaryCodexHome(),
    overrideVariable: "CODEX_HOME",
    sessionRoots: (home) => {
        const homes = codexHomeOverrides();
        const bases = homes.length > 0 ? homes : [join(home, ".codex")];
        const roots: string[] = [];
        for (const base of bases) {
            for (const dir of homeLayout.sessionRootsForHome(base)) {
                if (!roots.includes(dir)) {
                    roots.push(dir);
                }
            }
        }
        return roots;
    },
    sessionRootsForHome: (providerHome) => [join(providerHome, "sessions"), join(providerHome, "archived_sessions")],
    isTranscript: (fileName) => fileName.endsWith(CODEX_COMPRESSED_SUFFIX) || fileName.endsWith(".jsonl"),
    transcriptMaxDepth: 4,
    legacyRoots: (root) => codexHomesIn(root).flatMap((home) => homeLayout.sessionRootsForHome(home)),
};
