/**
 * Server-side environment configuration. The single place that reads `process.env`.
 *
 * Design rule: ALL secrets come from env vars; NOTHING is hardcoded. Stripe and Cloudflare
 * are OPTIONAL — when their vars are absent the corresponding feature returns a graceful
 * "not configured" response and the server still boots (so the landing, auth, and the
 * dashboard all work credential-less, e.g. under Playwright). See `.env.example` for the
 * full list and `DevDashboard/research/22-impl-10-cloud-notes.md` for the mock-vs-real matrix.
 */

function optional(name: string): string | undefined {
    const value = process.env[name];

    if (value === undefined || value.trim() === "") {
        return undefined;
    }

    return value.trim();
}

function withDefault(name: string, fallback: string): string {
    return optional(name) ?? fallback;
}

export interface StripeEnv {
    secretKey: string;
    webhookSecret: string | undefined;
    priceProMonthly: string | undefined;
    priceProYearly: string | undefined;
    priceTeamMonthly: string | undefined;
}

export interface CloudflareEnv {
    apiToken: string;
    zoneId: string;
    /** The apex managed zone, e.g. `devdashboard.app`. */
    managedZone: string;
    /** The CNAME target managed subdomains route to (the vendor SaaS fallback origin). */
    fallbackOrigin: string;
}

export interface CloudEnv {
    nodeEnv: string;
    /** Public base URL of the cloud app (used for auth callbacks + emails). */
    appBaseUrl: string;
    /** Path to the SQLite database file (relative paths resolve from the web/ dir). */
    databaseUrl: string;
    /** When set to "postgres", the DB driver swaps to the Postgres dialect (Postgres-ready). */
    databaseDriver: "sqlite" | "postgres";
    /** Better-Auth secret used to sign sessions. A dev fallback is used when unset. */
    authSecret: string;
    /** The apex managed domain offered to managed-tier users, e.g. `devdashboard.app`. */
    managedDomain: string;
}

export function getCloudEnv(): CloudEnv {
    const driver = optional("DD_CLOUD_DATABASE_DRIVER") === "postgres" ? "postgres" : "sqlite";

    return {
        nodeEnv: withDefault("NODE_ENV", "development"),
        appBaseUrl: withDefault("DD_CLOUD_APP_URL", "http://localhost:7251"),
        databaseUrl: withDefault("DD_CLOUD_DATABASE_URL", "./data/cloud.db"),
        databaseDriver: driver,
        authSecret: withDefault("DD_CLOUD_AUTH_SECRET", "dev-only-insecure-secret-change-me"),
        managedDomain: withDefault("DD_CLOUD_MANAGED_DOMAIN", "devdashboard.app"),
    };
}

/** Returns Stripe config only when STRIPE_SECRET_KEY is present; otherwise null (inert). */
export function getStripeEnv(): StripeEnv | null {
    const secretKey = optional("STRIPE_SECRET_KEY");

    if (!secretKey) {
        return null;
    }

    return {
        secretKey,
        webhookSecret: optional("STRIPE_WEBHOOK_SECRET"),
        priceProMonthly: optional("STRIPE_PRICE_PRO_MONTHLY"),
        priceProYearly: optional("STRIPE_PRICE_PRO_YEARLY"),
        priceTeamMonthly: optional("STRIPE_PRICE_TEAM_MONTHLY"),
    };
}

/** Returns Cloudflare-for-SaaS config only when all required vars are present; otherwise null. */
export function getCloudflareEnv(): CloudflareEnv | null {
    const apiToken = optional("CLOUDFLARE_API_TOKEN");
    const zoneId = optional("CLOUDFLARE_ZONE_ID");

    if (!apiToken || !zoneId) {
        return null;
    }

    return {
        apiToken,
        zoneId,
        managedZone: withDefault("DD_CLOUD_MANAGED_DOMAIN", "devdashboard.app"),
        fallbackOrigin: withDefault("CLOUDFLARE_FALLBACK_ORIGIN", "fallback.devdashboard.app"),
    };
}

export function isStripeConfigured(): boolean {
    return getStripeEnv() !== null;
}

export function isCloudflareConfigured(): boolean {
    return getCloudflareEnv() !== null;
}
