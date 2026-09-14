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

export interface ReservedManagedSubdomain {
    accountId: string;
    hostname: string;
    name: string;
}

export const cloudStore = {
    // ── Subscriptions ─────────────────────────────────────────────────────────
    async getSubscription(accountId: string) {
        ensureMigrated();
        const rows = await db.select().from(subscriptions).where(eq(subscriptions.accountId, accountId)).limit(1);
        return rows[0] ?? null;
    },

    /**
     * Locate the account behind a Stripe subscription id. The metadata-independent path: it also
     * resolves subscriptions created outside this code (the Stripe dashboard, the billing portal,
     * an import), which carry no metadata of ours at all.
     */
    async getSubscriptionByStripeId(stripeSubscriptionId: string) {
        ensureMigrated();
        const rows = await db
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
            .limit(1);
        return rows[0] ?? null;
    },

    async ensureSubscription(accountId: string, tier: "free" | "pro" | "team" = "free") {
        ensureMigrated();
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
        // Insert-then-read rather than check-then-insert: the unique index on account_id decides the
        // race, and the loser simply reads the winner's row instead of writing a duplicate.
        await db.insert(subscriptions).values(row).onConflictDoNothing();
        const stored = await this.getSubscription(accountId);
        return stored ?? row;
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

    /**
     * Take the name locally BEFORE anything is provisioned upstream. The unique indexes on `name`
     * and `hostname` are the only thing that can arbitrate two concurrent claims, so losing that
     * race must happen here rather than after a Cloudflare hostname already exists.
     */
    async reserveManagedSubdomain(input: ReservedManagedSubdomain) {
        ensureMigrated();
        const row = assertNoKeyMaterial("managed_subdomains", {
            id: randomUUID(),
            accountId: input.accountId,
            hostname: input.hostname,
            name: input.name,
            routingTarget: "",
            vendorFronted: true,
            status: "provisioning",
            createdAt: new Date().toISOString(),
        });
        await db.insert(managedSubdomains).values(row);
        return row;
    },

    /** Promote a reservation to `ready` with the routing the provisioner actually returned. */
    async finalizeManagedSubdomain(id: string, patch: { hostname: string; routingTarget: string; vendorFronted: boolean }) {
        ensureMigrated();
        assertNoKeyMaterial("managed_subdomains", { id, ...patch, status: "ready" });
        const rows = await db
            .update(managedSubdomains)
            .set({ ...patch, status: "ready" })
            .where(eq(managedSubdomains.id, id))
            .returning();
        return rows[0] ?? null;
    },

    /** Release a reservation whose provisioning failed. */
    async deleteManagedSubdomain(id: string) {
        ensureMigrated();
        await db.delete(managedSubdomains).where(eq(managedSubdomains.id, id));
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
            // The patch only carries allow-listed settings fields; assert defensively anyway, so the
            // boundary sits on the write rather than on the callers that happen to exist today.
            const row = assertNoKeyMaterial("account_settings", {
                accountId,
                ...patch,
                updatedAt: new Date().toISOString(),
            });
            await db
                .update(accountSettings)
                .set({ pushAlertsEnabled: row.pushAlertsEnabled, updatedAt: row.updatedAt })
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
