import { randomBytes } from "node:crypto";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { User } from "@app/shops/db/types";
import { nowUtcIso } from "@app/utils/sql-time";

export const SESSION_COOKIE_NAME = "shops_session";

export function randomToken(): string {
    return randomBytes(32).toString("base64url");
}

export function parseCookies(header: string | null): Record<string, string> {
    if (!header) {
        return {};
    }

    const out: Record<string, string> = {};
    for (const part of header.split(";")) {
        const trimmed = part.trim();
        if (trimmed.length === 0) {
            continue;
        }

        const eq = trimmed.indexOf("=");
        if (eq === -1) {
            continue;
        }

        out[trimmed.slice(0, eq)] = decodeURIComponent(trimmed.slice(eq + 1));
    }

    return out;
}

export async function getSessionUser(request: Request, db: ShopsDatabase): Promise<User | null> {
    const cookies = parseCookies(request.headers.get("Cookie"));
    const token = cookies[SESSION_COOKIE_NAME];
    if (!token) {
        return null;
    }

    const row = await db
        .kysely()
        .selectFrom("sessions")
        .innerJoin("users", "users.id", "sessions.user_id")
        .select([
            "users.id as id",
            "users.email as email",
            "users.password_hash as password_hash",
            "users.display_name as display_name",
            "users.created_at as created_at",
            "users.updated_at as updated_at",
            "sessions.expires_at as expires_at",
        ])
        .where("sessions.token", "=", token)
        .executeTakeFirst();
    if (!row) {
        return null;
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
        return null;
    }

    try {
        await db
            .kysely()
            .updateTable("sessions")
            .set({ last_seen_at: nowUtcIso() })
            .where("token", "=", token)
            .execute();
    } catch {
        // best-effort; do not fail the request
    }

    return {
        id: row.id,
        email: row.email,
        password_hash: row.password_hash,
        display_name: row.display_name,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}
