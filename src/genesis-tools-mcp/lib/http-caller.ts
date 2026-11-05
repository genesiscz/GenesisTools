import {
    callerSessionReadable,
    codexThreadIdFromOpenFiles,
    type PeerCaller,
    readPeerCaller,
} from "@genesiscz/utils/agent/identity";

export { callerSessionReadable, codexThreadIdFromOpenFiles };

/** What the gateway learns about a remote caller: the identity module's peer answer, which fits `AgentCaller`. */
export type ResolvedCaller = PeerCaller;

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
