import { randomBytes } from "node:crypto";
import { logger } from "@app/logger";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { YtUser } from "@app/youtube/lib/users.types";
import { STARTING_CREDITS } from "@app/youtube/lib/users.types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function normalizeEmail(email: string): string {
    const normalized = email.trim().toLowerCase();

    if (!EMAIL_PATTERN.test(normalized)) {
        throw new Error("Please enter a valid email address");
    }

    return normalized;
}

function assertPassword(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
}

export async function registerUser(
    db: YoutubeDatabase,
    input: { email: string; password: string }
): Promise<{ user: YtUser; token: string }> {
    const email = normalizeEmail(input.email);
    assertPassword(input.password);

    if (db.getUserByEmail(email)) {
        throw new Error("An account with this email already exists");
    }

    const passwordHash = await Bun.password.hash(input.password, "argon2id");
    const token = `ytu_${randomBytes(32).toString("hex")}`;
    const created = db.createUser({ email, passwordHash, apiToken: token });
    const credits = db.grantCredits(created.id, STARTING_CREDITS, "register-grant");
    logger.info({ userId: created.id, tokenPrefix: token.slice(0, 8) }, "youtube users: registered");

    return { user: { ...created, credits }, token };
}

export async function loginUser(
    db: YoutubeDatabase,
    input: { email: string; password: string }
): Promise<{ user: YtUser; token: string }> {
    const email = normalizeEmail(input.email);
    const stored = db.getUserByEmail(email);
    // Same message for unknown email and wrong password — no account enumeration.
    const invalid = new Error("Invalid email or password");

    if (!stored) {
        logger.warn({ reason: "unknown-email" }, "youtube users: login rejected");
        throw invalid;
    }

    const verified = await Bun.password.verify(input.password, stored.passwordHash);

    if (!verified) {
        logger.warn({ userId: stored.id, reason: "wrong-password" }, "youtube users: login rejected");
        throw invalid;
    }

    db.touchUserLogin(stored.id);
    logger.info({ userId: stored.id }, "youtube users: logged in");
    const { passwordHash: _hash, apiToken, ...user } = stored;

    return { user, token: apiToken };
}
