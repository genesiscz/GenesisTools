import { createHash, randomBytes } from "node:crypto";
import { logger } from "@app/logger";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { YtUser } from "@app/youtube/lib/users.types";
import { STARTING_CREDITS } from "@app/youtube/lib/users.types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

// Fixed argon2id hash verified against on unknown-email logins so the response
// time matches the wrong-password path — denies account enumeration by timing.
const DUMMY_PASSWORD_HASH =
    "$argon2id$v=19$m=65536,t=2,p=1$fYHkbO0CZr8gnIpHcvfJ3CLwnFvntI53nuY2Tkn9q2Q$XewkWtrxB6KvLNEfOceWqdHPg6/7Bq2cWgdREkWXroE";

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
    // Atomic: a crash between the insert and the grant must not leave a
    // registered account with no starting credits and no ledger row.
    const { created, credits } = db.transaction(() => {
        const user = db.createUser({ email, passwordHash, apiToken: token });
        const balance = db.grantCredits(user.id, STARTING_CREDITS, "register-grant");

        return { created: user, credits: balance };
    });
    logger.info(
        { userId: created.id, tokenHash: createHash("sha256").update(token).digest("hex").slice(0, 12) },
        "youtube users: registered"
    );

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
        // Burn a comparable amount of time so an unknown email is not
        // distinguishable from a wrong password by response latency.
        await Bun.password.verify(input.password, DUMMY_PASSWORD_HASH);
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
