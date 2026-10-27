/** The connection a harness request came on: the gateway's peer ports, which name the harness process. */
export interface HostedPeer {
    clientPort: number;
    serverPort: number;
}

/** A hosted server's request handler; the gateway or its child process calls it. */
export type HostedHandler = (request: Request, peer: HostedPeer | null) => Promise<Response>;

/** The child prints this once it listens. */
export const HOSTED_READY_LINE = "ready";
/** The child prints this when it stops taking requests (its code changed); the next call starts a new child. */
export const HOSTED_DRAINING_LINE = "draining";
/** The gateway passes the peer to the child in this header; the child removes it before the handler runs. */
export const HOSTED_PEER_HEADER = "x-genesis-hosted-peer";
