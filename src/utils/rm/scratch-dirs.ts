/**
 * The folder under the shared temp root each agent keeps its session scratch in. A module with no imports, so the
 * shell guard (which runs before every Bash call) can read it without loading the rest of `tools rm`.
 */
export const AGENT_SCRATCH_DIRS: Readonly<Record<string, string>> = {
    "claude-code": "cc",
    codex: "codex",
    grok: "grok",
    copilot: "copilot",
};

/** The scratch folder of an agent this table does not name. */
export const OTHER_AGENT_SCRATCH_DIR = "agents";

export function agentScratchDir(agent: string): string {
    return AGENT_SCRATCH_DIRS[agent] ?? OTHER_AGENT_SCRATCH_DIR;
}

/** Every scratch root folder name directly in the temp root, the shared `cc` included. */
export function scratchRootNames(): ReadonlySet<string> {
    return new Set([...Object.values(AGENT_SCRATCH_DIRS), OTHER_AGENT_SCRATCH_DIR]);
}
