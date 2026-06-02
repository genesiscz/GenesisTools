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

import { getCloudflareEnv } from "@/lib/server/env";

export interface ProvisionResult {
    configured: boolean;
    hostname: string;
    routing: { target: string };
    vendorFronted: boolean;
    /** When configured=false, why (so the UI can show the right "demo mode" note). */
    note?: string;
}

const NAME_RE = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/;

export function isValidSubdomainName(name: string): boolean {
    return NAME_RE.test(name);
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
            hostname: `${name}.devdashboard.app`,
            routing: { target: `${name}.cfargotunnel.com` },
            vendorFronted: true,
            note: "Cloudflare for SaaS is not configured (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID unset). This subdomain is reserved in your account but not yet live on the edge.",
        };
    }

    const hostname = `${name}.${env.managedZone}`;
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

    const body = (await res.json()) as CloudflareCustomHostnameResponse;

    if (!res.ok || !body.success) {
        const detail = body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
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
