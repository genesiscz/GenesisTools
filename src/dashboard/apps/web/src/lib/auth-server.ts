import type { User } from "@workos-inc/node";
import { WorkOS } from "@workos-inc/node";
import { sealData, unsealData } from "iron-session";

// WorkOS client singleton
const workos = new WorkOS(process.env.WORKOS_API_KEY);

export { workos };

// Cookie configuration
export const COOKIE_NAME = "wos-session";
export const COOKIE_OPTIONS = {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 60 * 60 * 24 * 30, // 30 days
};

// Session types
export interface Impersonator {
    email: string;
    reason: string | null;
}

export interface Session {
    accessToken: string;
    refreshToken: string;
    user: User;
    impersonator?: Impersonator;
}

// Encrypt session data
export async function encryptSession(session: Session): Promise<string> {
    const password = process.env.WORKOS_COOKIE_PASSWORD;
    if (!password || password.length < 32) {
        throw new Error("WORKOS_COOKIE_PASSWORD must be set and at least 32 characters long");
    }
    return await sealData(session, { password });
}

// Decrypt session data
export async function decryptSession(encryptedSession: string): Promise<Session | null> {
    const password = process.env.WORKOS_COOKIE_PASSWORD;
    if (!password || password.length < 32) {
        return null;
    }
    try {
        return await unsealData<Session>(encryptedSession, { password });
    } catch {
        return null;
    }
}

// Get auth config for client-side use
export function getAuthConfig() {
    return {
        clientId: process.env.WORKOS_CLIENT_ID || "",
        cookiePassword: process.env.WORKOS_COOKIE_PASSWORD || "",
        redirectUri: process.env.WORKOS_REDIRECT_URI || "",
    };
}
