/**
 * Server functions backing the customer dashboard. Each one resolves the signed-in user from the
 * live request (via the auth-service) and reads/writes through the CloudStore — so every write is
 * guarded by the data-boundary. Components call these via TanStack Query (queries.ts) / direct await.
 */

import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { authService } from "@/lib/auth/auth-service";
import { cloudStore } from "@/lib/db/cloud-store";
import { isValidSubdomainName, provisionManagedSubdomain } from "@/lib/provision/cloudflare";

async function currentUserId(): Promise<string> {
    const request = getRequest();
    const user = await authService.requireAuth(request.headers);
    return user.id;
}

export const getOverview = createServerFn({ method: "GET" }).handler(async () => {
    const accountId = await currentUserId();
    const [subscription, devices, subdomain, settings] = await Promise.all([
        cloudStore.ensureSubscription(accountId),
        cloudStore.listDevices(accountId),
        cloudStore.getManagedSubdomain(accountId),
        cloudStore.getSettings(accountId),
    ]);

    return {
        subscription,
        deviceCount: devices.length,
        subdomain,
        pushAlertsEnabled: settings?.pushAlertsEnabled ?? true,
    };
});

export const listDevices = createServerFn({ method: "GET" }).handler(async () => {
    const accountId = await currentUserId();
    return cloudStore.listDevices(accountId);
});

const removeDeviceInput = z.object({ deviceId: z.string().min(1) });

export const removeDevice = createServerFn({ method: "POST" })
    .inputValidator(removeDeviceInput)
    .handler(async ({ data }) => {
        const accountId = await currentUserId();
        const devices = await cloudStore.listDevices(accountId);
        const owned = devices.some((d) => d.id === data.deviceId);

        if (!owned) {
            throw new Error("Device not found");
        }

        await cloudStore.removeDevice(accountId, data.deviceId);
        return { ok: true };
    });

export const getSettings = createServerFn({ method: "GET" }).handler(async () => {
    const accountId = await currentUserId();
    const settings = await cloudStore.getSettings(accountId);
    return { pushAlertsEnabled: settings?.pushAlertsEnabled ?? true };
});

const updateSettingsInput = z.object({ pushAlertsEnabled: z.boolean() });

export const updateSettings = createServerFn({ method: "POST" })
    .inputValidator(updateSettingsInput)
    .handler(async ({ data }) => {
        const accountId = await currentUserId();
        await cloudStore.upsertSettings(accountId, { pushAlertsEnabled: data.pushAlertsEnabled });
        return { ok: true };
    });

export const getSubdomain = createServerFn({ method: "GET" }).handler(async () => {
    const accountId = await currentUserId();
    return cloudStore.getManagedSubdomain(accountId);
});

const claimSubdomainInput = z.object({
    name: z.string().min(3).max(32).refine(isValidSubdomainName, "Use 3–32 lowercase letters, digits, or hyphens."),
});

export const claimSubdomain = createServerFn({ method: "POST" })
    .inputValidator(claimSubdomainInput)
    .handler(async ({ data }) => {
        const accountId = await currentUserId();

        const existing = await cloudStore.getManagedSubdomain(accountId);

        if (existing) {
            throw new Error(`You already have a managed subdomain: ${existing.hostname}`);
        }

        // Real, env-gated Cloudflare-for-SaaS provisioning (inert without creds — returns a
        // reserved-but-not-live result the wizard surfaces as "demo mode").
        const result = await provisionManagedSubdomain(data.name);

        const row = await cloudStore.claimManagedSubdomain({
            accountId,
            hostname: result.hostname,
            name: data.name,
            routingTarget: result.routing.target,
            vendorFronted: result.vendorFronted,
        });

        return { subdomain: row, configured: result.configured, note: result.note ?? null };
    });

const pairDeviceInput = z.object({
    label: z.string().min(1).max(64),
    kind: z.enum(["phone", "agent"]),
    // The device's base64 X25519 PUBLIC key (the cloud stores public material only — D11).
    publicKey: z.string().min(1),
    // The out-of-band device code printed by `tools dev-dashboard pair` (proof the Mac is consenting).
    deviceCode: z.string().min(4),
});

export const pairDevice = createServerFn({ method: "POST" })
    .inputValidator(pairDeviceInput)
    .handler(async ({ data }) => {
        const accountId = await currentUserId();

        // The cloud never validates/decrypts the pairing secret itself — the device code is an
        // out-of-band anchor proving the Mac agent (which printed it via `tools dev-dashboard pair`)
        // consents. The cloud records the device's PUBLIC key only. The real E2E handshake (X25519
        // ECDH → per-message AEAD) happens phone↔Mac, never through us (plan 02).
        const device = await cloudStore.addDevice({
            accountId,
            label: data.label,
            kind: data.kind,
            publicKey: data.publicKey,
        });

        return { device };
    });
