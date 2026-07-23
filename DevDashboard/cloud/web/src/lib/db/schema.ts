/**
 * Drizzle schema for the cloud DB (SQLite dialect). Two groups of tables:
 *
 *   1. Better-Auth tables (`user`, `session`, `account`, `verification`) — owned by Better-Auth's
 *      schema; credentials/sessions live here. We declare them so drizzle-kit can migrate them and
 *      so the drizzle adapter can map onto them.
 *   2. Domain tables (`accounts`, `subscriptions`, `devices`, `managed_subdomains`, `account_settings`)
 *      — the product's own data. Every write into these goes through assertNoKeyMaterial (data-boundary).
 *
 * Postgres-ready: the column types here are SQLite; the Postgres port lives in `schema.pg.ts`
 * (mirror) and is selected by the driver in `index.ts`. Keeping the SQLite schema as the default
 * keeps the stub zero-dependency on a running Postgres.
 */

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ── Better-Auth core tables ──────────────────────────────────────────────────

export const user = sqliteTable("user", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    image: text("image"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const session = sqliteTable("session", {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const verification = sqliteTable("verification", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" }),
});

// ── Domain tables ─────────────────────────────────────────────────────────────

export const subscriptions = sqliteTable("subscriptions", {
    id: text("id").primaryKey(),
    accountId: text("account_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    tier: text("tier").notNull().default("free"),
    status: text("status").notNull().default("active"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    currentPeriodEnd: text("current_period_end"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const devices = sqliteTable("devices", {
    id: text("id").primaryKey(),
    accountId: text("account_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    kind: text("kind").notNull(),
    publicKey: text("public_key").notNull(),
    pairedAt: text("paired_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const managedSubdomains = sqliteTable("managed_subdomains", {
    id: text("id").primaryKey(),
    accountId: text("account_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull().unique(),
    name: text("name").notNull().unique(),
    routingTarget: text("routing_target").notNull(),
    vendorFronted: integer("vendor_fronted", { mode: "boolean" }).notNull().default(true),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const accountSettings = sqliteTable("account_settings", {
    accountId: text("account_id")
        .primaryKey()
        .references(() => user.id, { onDelete: "cascade" }),
    pushAlertsEnabled: integer("push_alerts_enabled", { mode: "boolean" }).notNull().default(true),
    theme: text("theme").notNull().default("obsidian"),
    updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const schema = {
    user,
    session,
    account,
    verification,
    subscriptions,
    devices,
    managedSubdomains,
    accountSettings,
};
