import { callerSessionReadable, codexThreadIdFromOpenFiles, readPeerCaller } from "@genesiscz/utils/agent/identity";
import type { AgentCaller } from "@genesiscz/utils/agent/runtime";

export { callerSessionReadable, codexThreadIdFromOpenFiles };

export interface ResolvedCaller extends AgentCaller {
    pid: number | null;
    processName: string | null;
}

/**
 * The harness process that holds the client end of this connection, and what it is running. A thin adapter over the
 * agent identity module's peer source (`readPeerCaller`), which owns the lookup.
 */
export function resolveCallerFromPeer(opts: {
    clientPort: number;
    serverPort: number;
    claudeSessionsDir?: string;
}): ResolvedCaller {
    return readPeerCaller(opts);
}
