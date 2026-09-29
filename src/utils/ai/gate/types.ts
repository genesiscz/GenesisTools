/**
 * The account gate: another process asks for a token of one AI account, Martin approves it in a
 * native window with Touch ID, and the token comes back with its expiry.
 *
 * What comes back: for an Anthropic account with a long-lived setup token (`tools claude
 * login-long`), that token, which survives refreshes and lives far longer than an access token;
 * otherwise an OAuth access token. A leaked reply therefore exposes whatever that token is good
 * for until it expires or is revoked, not merely one access-token lifetime.
 *
 * What never comes back: the refresh token. An allowed request may REFRESH the account's grant
 * inside the vault when the access token has expired (a request is real use, not a diagnosis),
 * but the single-use refresh token itself never crosses this boundary.
 *
 * API-key providers (xai, openai): the account's STORED key, read from the vault in the gate
 * process. It does not expire, so a leaked reply is good until the key is rotated at the provider.
 */

export const GATE_SUBSCRIPTION_PROVIDERS = ["anthropic-sub", "openai-sub"] as const;
export const GATE_API_KEY_PROVIDERS = ["xai", "openai"] as const;
export const GATE_PROVIDERS = [...GATE_SUBSCRIPTION_PROVIDERS, ...GATE_API_KEY_PROVIDERS] as const;
export type GateProvider = (typeof GATE_PROVIDERS)[number];
export type GateApiKeyProvider = (typeof GATE_API_KEY_PROVIDERS)[number];

export function isGateProvider(value: string): value is GateProvider {
    return (GATE_PROVIDERS as readonly string[]).includes(value);
}

export function isApiKeyGateProvider(value: string): value is GateApiKeyProvider {
    return (GATE_API_KEY_PROVIDERS as readonly string[]).includes(value);
}

/** What the asking process says about itself. The pid lets the gate check the claim. */
export interface GateClient {
    /** Short handle shown in the approval window, e.g. "pi" or "GenesisPi". */
    name: string;
    /**
     * The asking process. There is no default: an omitted pid leaves the client unidentified, so
     * the window can allow it once and nothing is remembered. (`process.ppid` would name the app
     * launcher, and a grant keyed on it would cover every tool run.)
     */
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
    /**
     * Account name or id as listed by `tools ai accounts list`. Optional for an API-key provider:
     * the gate then picks an enabled account of that provider that holds a stored key, one tagged
     * `gate-only` first.
     */
    account?: string;
}

export type ApprovalMethod = "touch-id" | "password" | "none";

export type ApprovalDecision =
    | { decision: "allow"; rememberSeconds: number; method: ApprovalMethod }
    | { decision: "deny"; reason: string };

/** A remembered approval. Matched on client key, provider, account id and the token kind approved. */
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
    /** Epoch ms after which the grant stops matching. Only a timed approval is stored; "allow once" writes no grant. */
    until: number;
    method: ApprovalMethod;
    /**
     * What the window said it shared. A grant only covers that kind: if the account's long-lived
     * token appears or disappears, the next request asks again. Grants written before this field
     * existed carry none, match nothing, and so ask once more.
     */
    tokenKind?: TokenKind;
}

/**
 * `long-lived`: an Anthropic setup token (`tools claude login-long`); it survives OAuth refreshes
 * by other processes. `access`: an OAuth access token, valid until someone refreshes the pair or
 * it expires, so a holder must expect a 401 and ask again. `api-key`: the stored API key of an
 * API-key account; it has no expiry and works until it is rotated at the provider.
 */
export type TokenKind = "long-lived" | "access" | "api-key";

export interface GateResult {
    provider: GateProvider;
    account: { id: string; name: string; label?: string };
    /** The secret `tokenKind` names: an OAuth access token, a long-lived token, or an API key. */
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
    | "timeout"
    | "token_kind_changed"
    | "no_stored_key";

export class GateDeniedError extends Error {
    constructor(
        readonly code: GateDenyCode,
        message: string
    ) {
        super(message);
        this.name = "GateDeniedError";
    }
}
