import type { SessionPin } from "@genesiscz/utils/agent-sessions/pins";
import { type AgentCmuxSurface, type AgentCmuxTree, fetchAgentCmuxTree } from "@genesiscz/utils/cmux/agent-tree";
import type { CmuxLiveSnapshot } from "@genesiscz/utils/cmux/lib/live-snapshot";
import type { SessionCmuxRefs } from "@genesiscz/utils/cmux/session-refs";

/**
 * `tools claude cmux tree`: the agent tree (`@genesiscz/utils/cmux/agent-tree`) with Claude's
 * sessions only. The JSON shape is what Genesis's `CmuxTreeClient` decodes; keep it stable.
 */
export type CmuxTreeSurface = AgentCmuxSurface;
export type CmuxTree = AgentCmuxTree;

interface TreeDeps {
    fetchSnapshot?: () => Promise<CmuxLiveSnapshot>;
    loadRefs?: () => Map<string, SessionCmuxRefs>;
    loadPins?: () => Promise<Map<string, SessionPin>>;
}

export function fetchCmuxTree(deps: TreeDeps = {}): Promise<CmuxTree> {
    return fetchAgentCmuxTree({ ...deps, providers: ["claude"] });
}
