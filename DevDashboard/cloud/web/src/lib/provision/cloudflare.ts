/**
 * Cloudflare-for-SaaS custom-hostname provisioning — the managed-subdomain backend (D10).
 * SERVER-ONLY.
 *
 * Real code path, ENV-GATED: the Cloudflare client is lazy-initialised behind getCloudflareEnv()
 * (server/lib/env.ts). With no CLOUDFLARE_* env present, `provisionManagedSubdomain` returns a
 * `{ configured: false }` result and the caller stubs gracefully — the server never crashes and the
 * wizard still renders. With env present, it calls the Cloudflare API to register a custom hostname
 * under the managed zone and returns the routing target the user's tunnel CNAMEs to.
 *
 * Contract parity: the agent side calls `requestManagedSubdomain({ cloudApiToken, desiredName })`
 * and expects `{ hostname, routing: { target }, vendorFronted }` (see
 * src/dev-dashboard/lib/tunnel/cloudflared.ts). This module produces exactly that shape so the
 * Cloud API the agent codes against is satisfied.
 */

import { getCloudEnv, getCloudflareEnv } from "@/lib/server/env";

export interface ProvisionResult {
    configured: boolean;
    hostname: string;
    routing: { target: string };
    vendorFronted: boolean;
    /** When configured=false, why (so the UI can show the right "demo mode" note). */
    note?: string;
}

// 3-32 characters, matching every error string in the flow. The optional-group form this replaced
// accepted a single character and rejected two, both against what the messages promise.
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export function isValidSubdomainName(name: string): boolean {
    return NAME_RE.test(name);
}

/**
 * The hostname `provisionManagedSubdomain` will register. Computable before the upstream call, so a
 * caller can reserve the row locally first. Demo mode and the real path agree on the apex.
 */
export function managedHostname(name: string): string {
    return `${name}.${getCloudEnv().managedDomain}`;
}

interface CloudflareCustomHostnameResponse {
    success: boolean;
    errors: Array<{ code: number; message: string }>;
    result?: { id: string; hostname: string };
}

/**
 * Provision `<name>.<managedZone>` as a Cloudflare custom hostname. Inert (configured:false) when
 * CLOUDFLARE_* env is absent. Throws on a real API failure when configured.
 */
export async function provisionManagedSubdomain(name: string): Promise<ProvisionResult> {
    if (!isValidSubdomainName(name)) {
        throw new Error("Invalid subdomain name. Use 3–32 lowercase letters, digits, or hyphens.");
    }

    const env = getCloudflareEnv();

    if (!env) {
        // Demo mode: synthesize a deterministic result so the wizard + DB flow are fully exercisable
        // without a Cloudflare account. The hostname is real-shaped; nothing is provisioned upstream.
        return {
            configured: false,
            hostname: managedHostname(name),
            routing: { target: `${name}.cfargotunnel.com` },
            vendorFronted: true,
            note: "Cloudflare for SaaS is not configured (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID unset). This subdomain is reserved in your account but not yet live on the edge.",
        };
    }

    const hostname = managedHostname(name);
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.zoneId}/custom_hostnames`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${env.apiToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            hostname,
            ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
        }),
    });

    // Read as text first: a 502 from a proxy in front of the API answers with HTML, and parsing that
    // straight away would throw a JSON syntax error over the status, which is the one fact that says
    // whether retrying is worth it.
    const raw = await res.text();
    let body: CloudflareCustomHostnameResponse | null = null;

    try {
        body = JSON.parse(raw) as CloudflareCustomHostnameResponse;
    } catch {
        // Non-JSON body (an HTML gateway or login page). The status and snippet below carry it.
    }

    if (!res.ok || !body?.success) {
        const detail = body?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}: ${raw.slice(0, 200)}`;
        throw new Error(`Cloudflare custom-hostname provisioning failed: ${detail}`);
    }

    return {
        configured: true,
        hostname,
        routing: { target: env.fallbackOrigin },
        // Vendor CF terminates TLS at the edge → the managed-tier E2E layer is REQUIRED for no-see.
        vendorFronted: true,
    };
}
