import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export interface DashboardAuthConfig {
    enabled: boolean;
    username: string;
    passwordSalt?: string;
    passwordHash?: string;
}

export interface CompleteDashboardAuthConfig extends DashboardAuthConfig {
    passwordSalt: string;
    passwordHash: string;
}

interface CreateBasicAuthOptions {
    username?: string;
    password?: string;
    salt?: string;
}

interface BasicAuthInput {
    username: string;
    password: string;
}

const PASSWORD_KEY_LENGTH = 32;

function hashPassword(password: string, salt: string): string {
    return scryptSync(password, salt, PASSWORD_KEY_LENGTH).toString("hex");
}

function secureHexEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, "hex");
    const rightBuffer = Buffer.from(right, "hex");

    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuthHeader(header: string | null): BasicAuthInput | null {
    if (!header?.startsWith("Basic ")) {
        return null;
    }

    const encoded = header.slice("Basic ".length).trim();
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");

    if (separatorIndex < 1) {
        return null;
    }

    return {
        username: decoded.slice(0, separatorIndex),
        password: decoded.slice(separatorIndex + 1),
    };
}

export function createBasicAuthCredentials(options: CreateBasicAuthOptions = {}): {
    auth: CompleteDashboardAuthConfig;
    password: string;
} {
    const username = options.username ?? "martin";
    const password = options.password ?? randomBytes(24).toString("base64url");
    const passwordSalt = options.salt ?? randomBytes(16).toString("base64url");

    return {
        auth: {
            enabled: true,
            username,
            passwordSalt,
            passwordHash: hashPassword(password, passwordSalt),
        },
        password,
    };
}

export function isCompleteAuthConfig(auth: DashboardAuthConfig): auth is CompleteDashboardAuthConfig {
    return Boolean(auth.passwordHash && auth.passwordSalt);
}

export function makeBasicAuthHeader(input: BasicAuthInput): string {
    return `Basic ${Buffer.from(`${input.username}:${input.password}`).toString("base64")}`;
}

export function verifyBasicAuthHeader(header: string | null, auth: CompleteDashboardAuthConfig): boolean {
    const parsed = parseBasicAuthHeader(header);

    if (!parsed || parsed.username !== auth.username) {
        return false;
    }

    return secureHexEqual(hashPassword(parsed.password, auth.passwordSalt), auth.passwordHash);
}
