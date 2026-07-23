import type { TransportTier } from "@/transport/Transport";

/**
 * A persisted connection the user has saved. The list of these (plus an "active id") is what makes
 * the app multi-connection: each saved row can be re-activated to switch which Mac/agent the whole
 * app talks to. The password is NEVER stored here — it lives in SecureStore under
 * `dd_basic_password_<id>` and is re-read only when the connection is (re)activated.
 */
export interface SavedConnection {
    id: string;
    label: string;
    tier: TransportTier;
    baseUrl: string;
    host: string;
    port: number;
    username: string;
    addedAt: number;
    lastUsedAt: number;
}

/** Fields a caller provides when saving a new connection (ids/timestamps are assigned by the store). */
export interface SavedConnectionInput {
    label?: string;
    tier: TransportTier;
    baseUrl: string;
    host: string;
    port: number;
    username: string;
    /** Plaintext password, persisted to SecureStore (never to the kv list). Omit/empty for no auth. */
    password?: string;
}

/** Mutable fields the connections screen can edit in place. */
export interface SavedConnectionPatch {
    label?: string;
    host?: string;
    port?: number;
    username?: string;
    baseUrl?: string;
    password?: string;
}
