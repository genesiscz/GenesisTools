import { homedir } from "node:os";
import { join } from "node:path";

/** The session trees the walk benchmarks read (read-only), shaped like the listing walks them. */
export const WALK_TREES = {
    /** The Claude listing: project folders only (`maxDepth: 1`), as `excludeAgents` walks them. */
    "claude-listing": { roots: [join(homedir(), ".claude", "projects")], names: ["*.jsonl"], maxDepth: 1 },
    /** Every Claude transcript, sub-agents included: what a full sync or a transcript scan walks. */
    "claude-all": { roots: [join(homedir(), ".claude", "projects")], names: ["*.jsonl"], maxDepth: undefined },
    /** Grok sessions down to `<cwd>/<session>/`, as the filtered Grok walk reads them. */
    grok: {
        roots: [join(homedir(), ".grok", "sessions")],
        names: ["chat_history.jsonl", "chatHistory.jsonl"],
        maxDepth: 2,
    },
    /** Codex's dated rollout tree. */
    codex: { roots: [join(homedir(), ".codex", "sessions")], names: ["*.jsonl"], maxDepth: undefined },
} satisfies Record<string, { roots: string[]; names: string[]; maxDepth: number | undefined }>;

export type WalkTreeName = keyof typeof WALK_TREES;

/** The walkers `walk-child.ts` can run; `walk-primitives.ts` runs each of them on every tree. */
export const WALK_ARMS = ["native", "clang", "tcc", "js", "walkSourceRoots"] as const;
