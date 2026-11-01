/** `auto` is a strategy over the transports, not a transport: plain first, chrome once when plain is refused. */
export const TRANSPORT_CHOICES = ["plain", "chrome", "auto"] as const;
export type TransportChoice = (typeof TRANSPORT_CHOICES)[number];
export type TransportName = Exclude<TransportChoice, "auto">;

export const FETCH_MODES = ["markdown", "raw", "jsonld"] as const;
export type FetchMode = (typeof FETCH_MODES)[number];

export function isTransportChoice(value: string): value is TransportChoice {
    return TRANSPORT_CHOICES.some((choice) => choice === value);
}

export function isFetchMode(value: string): value is FetchMode {
    return FETCH_MODES.some((mode) => mode === value);
}

export interface TransportRequest {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
}

/** One HTTP answer, redirects NOT followed: the fetcher follows them itself so headers stay with their origin. */
export interface TransportResponse {
    status: number;
    /** Header names lower-cased. */
    headers: Record<string, string>;
    body: string;
}

/** One way to put a request on the wire. Adding a transport is one implementation plus one row in TRANSPORTS. */
export interface HttpTransport {
    readonly name: TransportName;
    send(request: TransportRequest): Promise<TransportResponse>;
    /** Releases what the transport holds (the chrome worker). It may be used again afterwards. */
    close(): Promise<void>;
}

/** Why a response is not the page: a bot challenge, or a refusal status. */
export interface BlockVerdict {
    vendor: string;
    /** What gave it away, e.g. `header cf-mitigated: challenge` or `HTTP 403`. */
    signal: string;
    /** True for a recognised challenge page; false for a bare refusal status. */
    challenge: boolean;
}

export interface Escalation {
    from: TransportName;
    /** The status the first transport got. */
    status: number;
    reason: BlockVerdict;
}

export interface FetchedPage {
    /** The address after redirects. */
    url: string;
    status: number;
    headers: Record<string, string>;
    body: string;
    /** The transport that produced this answer. */
    transport: TransportName;
    /** Set when `auto` retried through chrome. */
    escalation?: Escalation;
}
