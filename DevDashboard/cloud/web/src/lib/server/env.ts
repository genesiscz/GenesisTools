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

/**
 * The dev fallback exists so the app boots credential-less locally. In production it must NOT: the
 * literal is committed to a public repo, and anyone holding it can sign a session cookie for any
 * user id. Fail closed instead of booting on a known secret.
 */
function resolveAuthSecret(nodeEnv: string): string {
    const secret = optional("DD_CLOUD_AUTH_SECRET");

    if (secret) {
        return secret;
    }

    if (nodeEnv === "production") {
        throw new Error(
            "DD_CLOUD_AUTH_SECRET must be set in production. Sessions are signed with it, and the " +
                "development fallback is a public literal that would let anyone mint a session."
        );
    }

    return "dev-only-insecure-secret-change-me";
}

export interface CloudEnv {
    nodeEnv: string;
    /** Public base URL of the cloud app (used for auth callbacks + emails). */
    appBaseUrl: string;
    /** Path to the SQLite database file (relative paths resolve from the web/ dir). */
    databaseUrl: string;
    /** When set to "postgres", the DB driver swaps to the Postgres dialect (Postgres-ready). */
    databaseDriver: "sqlite" | "postgres";
    /** Better-Auth secret used to sign sessions. Required in production; dev falls back. */
    authSecret: string;
    /** The apex managed domain offered to managed-tier users, e.g. `devdashboard.app`. */
    managedDomain: string;
}

export function getCloudEnv(): CloudEnv {
    const driver = optional("DD_CLOUD_DATABASE_DRIVER") === "postgres" ? "postgres" : "sqlite";
    const nodeEnv = withDefault("NODE_ENV", "development");

    return {
        nodeEnv,
        appBaseUrl: withDefault("DD_CLOUD_APP_URL", "http://localhost:7251"),
        databaseUrl: withDefault("DD_CLOUD_DATABASE_URL", "./data/cloud.db"),
        databaseDriver: driver,
        authSecret: resolveAuthSecret(nodeEnv),
        managedDomain: withDefault("DD_CLOUD_MANAGED_DOMAIN", "devdashboard.app"),
    };
}

/** Returns Stripe config only when STRIPE_SECRET_KEY is present; otherwise null (inert). */
export function getStripeEnv(): StripeEnv | null {
    const secretKey = optional("STRIPE_SECRET_KEY");

    if (!secretKey) {
        return null;
    }

    const webhookSecret = optional("STRIPE_WEBHOOK_SECRET");

    if (!webhookSecret && withDefault("NODE_ENV", "development") === "production") {
        // Half-configured billing is worse than none: checkout succeeds and charges the customer
        // while every webhook is discarded, so the account never leaves the free tier.
        throw new Error(
            "STRIPE_WEBHOOK_SECRET must be set in production whenever STRIPE_SECRET_KEY is set, or " +
                "every webhook is acknowledged without being applied."
        );
    }

    return {
        secretKey,
        webhookSecret,
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

let billingWarned = false;

/**
 * Whether billing is wired up. The managed-subdomain gate keys off this, so a PRODUCTION deployment
 * that reaches here unconfigured hands out a paid, globally-unique resource for free.
 *
 * That is legitimate on a self-hosted instance with no upgrade path, and a silent misconfiguration
 * everywhere else, and the two are indistinguishable from the code. So it is said out loud once
 * rather than failing closed, which would brick the deliberate case. NODE_ENV is read directly
 * instead of through `getCloudEnv()`, because that call throws when the auth secret is unset and a
 * diagnostic must not be the thing that crashes the boot.
 */
export function isStripeConfigured(): boolean {
    const configured = getStripeEnv() !== null;

    if (!configured && !billingWarned && withDefault("NODE_ENV", "development") === "production") {
        billingWarned = true;
        console.error(
            "[dd-cloud] STRIPE_SECRET_KEY is unset in production: billing is inert and the Pro gate on " +
                "managed subdomains is SKIPPED, so any account can claim a globally unique hostname for " +
                "free. Set STRIPE_SECRET_KEY, or accept this deliberately on a self-hosted instance."
        );
    }

    return configured;
}

export function isCloudflareConfigured(): boolean {
    return getCloudflareEnv() !== null;
}
