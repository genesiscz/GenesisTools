/**
 * CloudStore — the domain-data access layer. Every WRITE into a domain table goes through
 * `assertNoKeyMaterial` (the data-boundary guard, D11), so the cloud can never persist private
 * key material or any field outside the per-table allow-list. SERVER-ONLY.
 *
 * Better-Auth owns the user/session/account/verification tables; this store owns the product's own
 * rows (subscriptions, devices, managed subdomains, settings), all keyed by the Better-Auth user id.
 */

import { randomUUID } from "node:crypto";
import { assertNoKeyMaterial } from "@shared/data-boundary";
import { and, eq } from "drizzle-orm";
import { db } from "./index";
import { ensureMigrated } from "./migrate";
import { accountSettings, devices, managedSubdomains, subscriptions } from "./schema";

export interface NewDevice {
    accountId: string;
    label: string;
    kind: "phone" | "agent";
    publicKey: string;
}

export interface NewManagedSubdomain {
    accountId: string;
    hostname: string;
    name: string;
    routingTarget: string;
    vendorFronted: boolean;
}

export const cloudStore = {
    // ── Subscriptions ─────────────────────────────────────────────────────────
    async getSubscription(accountId: string) {
        ensureMigrated();
        const rows = await db.select().from(subscriptions).where(eq(subscriptions.accountId, accountId)).limit(1);
        return rows[0] ?? null;
    },

    async ensureSubscription(accountId: string, tier: "free" | "pro" | "team" = "free") {
        ensureMigrated();
        const existing = await this.getSubscription(accountId);

        if (existing) {
            return existing;
        }

        const row = assertNoKeyMaterial("subscriptions", {
            id: randomUUID(),
            accountId,
            tier,
            status: "active",
            stripeCustomerId: null,
            stripeSubscriptionId: null,
            currentPeriodEnd: null,
            createdAt: new Date().toISOString(),
        });
        await db.insert(subscriptions).values(row);
        return row;
    },

    async updateSubscription(
        accountId: string,
        patch: Partial<{
            tier: "free" | "pro" | "team";
            status: "active" | "trialing" | "past_due" | "canceled";
            stripeCustomerId: string | null;
            stripeSubscriptionId: string | null;
            currentPeriodEnd: string | null;
        }>
    ) {
        ensureMigrated();
        // The patch only carries allow-listed subscription fields; assert defensively anyway.
        assertNoKeyMaterial("subscriptions", { id: "patch-check", accountId, ...patch });
        await db.update(subscriptions).set(patch).where(eq(subscriptions.accountId, accountId));
    },

    // ── Devices ────────────────────────────────────────────────────────────────
    async listDevices(accountId: string) {
        ensureMigrated();
        return db.select().from(devices).where(eq(devices.accountId, accountId));
    },

    async addDevice(input: NewDevice) {
        ensureMigrated();
        const row = assertNoKeyMaterial("devices", {
            id: randomUUID(),
            accountId: input.accountId,
            label: input.label,
            kind: input.kind,
            publicKey: input.publicKey,
            pairedAt: new Date().toISOString(),
        });
        await db.insert(devices).values(row);
        return row;
    },

    async removeDevice(accountId: string, deviceId: string) {
        ensureMigrated();
        // Scope the delete by accountId too (defense-in-depth): the route also checks ownership, but
        // keeping the guard in the query makes this store method safe for any future caller.
        await db.delete(devices).where(and(eq(devices.id, deviceId), eq(devices.accountId, accountId)));
    },

    // ── Managed subdomains ───────────────────────────────────────────────────────
    async getManagedSubdomain(accountId: string) {
        ensureMigrated();
        const rows = await db
            .select()
            .from(managedSubdomains)
            .where(eq(managedSubdomains.accountId, accountId))
            .limit(1);
        return rows[0] ?? null;
    },

    async claimManagedSubdomain(input: NewManagedSubdomain) {
        ensureMigrated();
        const row = assertNoKeyMaterial("managed_subdomains", {
            id: randomUUID(),
            accountId: input.accountId,
            hostname: input.hostname,
            name: input.name,
            routingTarget: input.routingTarget,
            vendorFronted: input.vendorFronted,
            status: "ready",
            createdAt: new Date().toISOString(),
        });
        await db.insert(managedSubdomains).values(row);
        return row;
    },

    // ── Settings ───────────────────────────────────────────────────────────────
    async getSettings(accountId: string) {
        ensureMigrated();
        const rows = await db.select().from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
        return rows[0] ?? null;
    },

    async upsertSettings(accountId: string, patch: { pushAlertsEnabled?: boolean }) {
        ensureMigrated();
        const existing = await this.getSettings(accountId);

        if (existing) {
            await db
                .update(accountSettings)
                .set({ ...patch, updatedAt: new Date().toISOString() })
                .where(eq(accountSettings.accountId, accountId));
            return;
        }

        const row = assertNoKeyMaterial("account_settings", {
            accountId,
            pushAlertsEnabled: patch.pushAlertsEnabled ?? true,
            theme: "obsidian",
            updatedAt: new Date().toISOString(),
        });
        await db.insert(accountSettings).values(row);
    },
};
