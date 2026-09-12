import { formatClock, formatDuration } from "@genesiscz/utils/format";

export type AuthTokenState = "live" | "expired" | "missing" | "none";

export interface AuthStatusSnapshot {
    server: string;
    kind?: "oauth" | "bearer" | "none";
    gateway: boolean;
    hasAccess: boolean;
    expired: boolean;
    expiresAt?: number;
    now?: number;
}

export interface AuthStatusRowView {
    server: string;
    auth: string;
    token: AuthTokenState;
    expires: string;
    needsLogin: boolean;
}

export function describeAuthStatus(snap: AuthStatusSnapshot): AuthStatusRowView {
    const now = snap.now ?? Date.now();
    const kind = snap.kind ?? "none";
    const token = tokenState(kind, snap.hasAccess, snap.expired);

    return {
        server: snap.server,
        auth: authLabel(kind, snap.gateway),
        token,
        expires: formatExpiry(snap.expiresAt, now),
        needsLogin: kind === "oauth" && token !== "live",
    };
}

function authLabel(kind: "oauth" | "bearer" | "none", gateway: boolean): string {
    if (kind === "oauth" && gateway) {
        return "OAuth, gateway";
    }

    if (kind === "oauth") {
        return "OAuth";
    }

    if (kind === "bearer") {
        return "Bearer";
    }

    return "none";
}

function tokenState(kind: "oauth" | "bearer" | "none", hasAccess: boolean, expired: boolean): AuthTokenState {
    if (hasAccess && !expired) {
        return "live";
    }

    if (hasAccess && expired) {
        return "expired";
    }

    if (kind === "oauth" || kind === "bearer") {
        return "missing";
    }

    return "none";
}

export function formatExpiry(expiresAt: number | undefined, now: number): string {
    if (!expiresAt) {
        return "—";
    }

    const delta = expiresAt - now;
    const abs = Math.abs(delta);
    const sameDay = new Date(expiresAt).toDateString() === new Date(now).toDateString();
    const clock = formatClock(expiresAt, { date: sameDay ? "none" : "short" });
    const span = expirySpan(abs);

    if (delta >= 0) {
        return `in ${span} (${clock})`;
    }

    return `${span} ago (${clock})`;
}

function expirySpan(absMs: number): string {
    const twoDays = 48 * 60 * 60 * 1000;

    if (absMs >= twoDays) {
        return `${Math.round(absMs / 86_400_000)}d`;
    }

    return formatDuration(absMs, "ms", "hm-smart");
}
