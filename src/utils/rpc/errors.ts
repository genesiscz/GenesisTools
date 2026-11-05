/** The JSON-RPC 2.0 error codes every server answers; a service adds its own from 1001 (`RPC_ERRORS` of the recorder). */
export const JSON_RPC_ERRORS = {
    parse: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603,
} as const;

/**
 * The code a request cancelled by `$/cancel` answers with. The transport answers it for every service, so it lives
 * here; the recorder's error table names it `cancelled`, beside its own codes.
 */
export const RPC_CANCELLED = 1013;

/** A refused call: the code goes to the caller in the error reply, the message as its text. */
export class RpcError extends Error {
    constructor(
        readonly code: number,
        message: string,
        readonly data?: unknown
    ) {
        super(message);
        this.name = "RpcError";
    }
}
