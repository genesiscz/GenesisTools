/**
 * The account gate: another process asks for an ACCESS token of one AI account, Martin
 * approves it in a native window with Touch ID, and the token comes back with its expiry.
 *
 * A refresh token never crosses this boundary. The gate hands out what an access token
 * already is (short-lived, revocable by expiry) and keeps the single-use grant inside the
 * vault, so a leaked reply costs at most one token lifetime.
 */

export const GATE_PROVIDERS = ["anthropic-sub", "openai-sub"] as const;
export type GateProvider = (typeof GATE_PROVIDERS)[number];

export function isGateProvider(value: string): value is GateProvider {
    return (GATE_PROVIDERS as readonly string[]).includes(value);
}

/** What the asking process says about itself. The pid lets the gate check the claim. */
export interface GateClient {
    /** Short handle shown in the approval window, e.g. "pi" or "GenesisPi". */
    name: string;
    /** The asking process. Defaults to the parent of the CLI door when omitted. */
    pid?: number;
}

export interface ProcessAncestor {
    pid: number;
    command: string;
}

/** What the gate could verify about the asking process, shown in the approval window. */
export interface ClientIdentity {
    name: string;
    pid: number | null;
    /** The binary the kernel runs for the pid (lsof), or argv[0] when lsof could not read it, or null when not running. */
    executable: string | null;
    /** For an interpreter (node, bun, python…): the script it runs, absolute; the program that really asked. */
    script: string | null;
    /** Full command line, truncated for display. */
    command: string | null;
    cwd: string | null;
    /** Parent chain, nearest first, up to a few levels. */
    ancestors: ProcessAncestor[];
    /** Stable handle for a grant: the declared name, the real executable path and the script. */
    key: string;
    /** The pid is running and sits above the gate process in the process tree: it spawned this request. */
    isAncestor: boolean;
    /** Interpreter flags or environment that load code the script path does not name; non-empty blocks remembering. */
    injected: string[];
    /**
     * True when the pid is running AND is an ancestor of the process handling the request: the
     * client spawned the gate door, so it cannot be a bystander naming someone else's pid. Only a
     * verified identity can be remembered or matched against a remembered grant.
     */
    verified: boolean;
}

export interface GateRequest {
    client: GateClient;
    provider: GateProvider;
    /** Account name or id as listed by `tools ai accounts list`. */
    account: string;
}

export type ApprovalMethod = "touch-id" | "password" | "none";

export type ApprovalDecision =
    | { decision: "allow"; rememberSeconds: number; method: ApprovalMethod }
    | { decision: "deny"; reason: string };

/** A remembered approval. Matched on client key, provider and account id. */
export interface GateGrant {
    key: string;
    clientName: string;
    executable: string | null;
    /** The interpreter's script, when the client is one; display only, the key already carries it. */
    script?: string | null;
    provider: GateProvider;
    accountId: string;
    accountName: string;
    grantedAt: number;
    /** Epoch ms. A one-time approval stores `grantedAt` here and is spent by the request that won it. */
    until: number;
    method: ApprovalMethod;
}

/**
 * `long-lived`: an Anthropic setup token (`tools claude login-long`); it survives OAuth refreshes
 * by other processes. `access`: an OAuth access token, valid until someone refreshes the pair or
 * it expires, so a holder must expect a 401 and ask again.
 */
export type TokenKind = "long-lived" | "access";

export interface GateResult {
    provider: GateProvider;
    account: { id: string; name: string; label?: string };
    accessToken: string;
    tokenKind: TokenKind;
    /** Epoch ms when the provider says the token dies, or null when it did not say. */
    expiresAt: number | null;
    /** Epoch ms until which the grant is remembered, or null for a one-time approval. */
    grantedUntil: number | null;
    /** True when a window was shown for this request; false when a remembered grant answered. */
    prompted: boolean;
}

export type GateDenyCode =
    | "unknown_account"
    | "foreign_pid"
    | "disabled_account"
    | "provider_mismatch"
    | "denied"
    | "no_approver"
    | "timeout";

export class GateDeniedError extends Error {
    constructor(
        readonly code: GateDenyCode,
        message: string
    ) {
        super(message);
        this.name = "GateDeniedError";
    }
}
