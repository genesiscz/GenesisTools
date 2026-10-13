/**
 * The smallest CDP session the helpers in this folder need: one page target, commands and events.
 *
 * Declared with METHOD syntax on purpose. Method parameters are checked bivariantly, so a
 * playwright `CDPSession` (generic over protocol method and event names) assigns to it without a
 * cast, and so does the GenesisTools `Conn` adapter. Function-typed properties would fail that
 * assignment under `strictFunctionTypes`.
 */
export interface CdpLike {
    /**
     * `options.timeoutMs` is how long the caller is willing to wait for the answer; a session with its own
     * shorter command deadline must honor it. A session without one may ignore it (a 2-argument send fits).
     */
    send(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>;
    on(event: string, listener: (params: unknown) => void): unknown;
    off(event: string, listener: (params: unknown) => void): unknown;
}
