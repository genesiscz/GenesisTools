/**
 * The account data model + the exhaustive allow-list of fields the cloud is PERMITTED to
 * persist (per table). The cloud's data boundary IS the trust claim (D11): it MAY store
 * account rows, subscription rows, device rows (PUBLIC keys), and managed-subdomain rows
 * (public relay URL + routing); it MUST NEVER store private keys, derived session secrets,
 * or the pairing secret. `data-boundary.ts` enforces this against this allow-list.
 */

export type ProvisionStatus = "pending" | "provisioning" | "ready" | "failed";
export type SubscriptionTier = "free" | "pro" | "team";
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled";

export interface Account {
    id: string;
    email: string;
    name: string | null;
    createdAt: string;
}

export interface Subscription {
    id: string;
    accountId: string;
    tier: SubscriptionTier;
    status: SubscriptionStatus;
    /** Opaque external billing id (e.g. Stripe customer id); never card data. */
    stripeCustomerId: string | null;
    /** Opaque external subscription id (e.g. Stripe subscription id). */
    stripeSubscriptionId: string | null;
    /** ISO timestamp when the current period ends, if known. */
    currentPeriodEnd: string | null;
    createdAt: string;
}

/**
 * A device paired to the account. Stores ONLY the device's PUBLIC key (base64 X25519) —
 * the cloud uses it only to confirm identity at pairing (see plan 02); it never decrypts.
 */
export interface Device {
    id: string;
    accountId: string;
    /** Friendly label, e.g. "Martin's iPhone" or "mac-studio.local". */
    label: string;
    kind: "phone" | "agent";
    /** Base64 X25519 PUBLIC key only. */
    publicKey: string;
    pairedAt: string;
}

/**
 * A managed `<name>.devdashboard.app` subdomain reserved for the account. Stores ONLY public
 * routing material: the FQDN, the CNAME/custom-hostname target the user's tunnel routes to,
 * and whether the vendor CF account fronts TLS (which forces the E2E layer for the no-see claim).
 */
export interface ManagedSubdomain {
    id: string;
    accountId: string;
    /** The reserved hostname, e.g. `martin.devdashboard.app`. */
    hostname: string;
    /** Subdomain label only, e.g. `martin`. */
    name: string;
    /** CNAME / custom-hostname target the user's tunnel should be reachable at. */
    routingTarget: string;
    /** True when the VENDOR's CF account terminates TLS (E2E layer then REQUIRED). */
    vendorFronted: boolean;
    status: ProvisionStatus;
    createdAt: string;
}

export interface AccountSettings {
    accountId: string;
    /** Whether push alerts are enabled for this account. */
    pushAlertsEnabled: boolean;
    /** UI theme preference (purely cosmetic). */
    theme: "obsidian";
    updatedAt: string;
}

/** The exhaustive allow-list of fields the cloud is PERMITTED to persist, per table. */
export const CLOUD_PERSISTABLE_FIELDS = {
    accounts: ["id", "email", "name", "createdAt"],
    subscriptions: [
        "id",
        "accountId",
        "tier",
        "status",
        "stripeCustomerId",
        "stripeSubscriptionId",
        "currentPeriodEnd",
        "createdAt",
    ],
    devices: ["id", "accountId", "label", "kind", "publicKey", "pairedAt"],
    managed_subdomains: [
        "id",
        "accountId",
        "hostname",
        "name",
        "routingTarget",
        "vendorFronted",
        "status",
        "createdAt",
    ],
    account_settings: ["accountId", "pushAlertsEnabled", "theme", "updatedAt"],
} as const;

export type CloudTable = keyof typeof CLOUD_PERSISTABLE_FIELDS;
