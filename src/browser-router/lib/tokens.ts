import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage, withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

export interface TokenRecord {
    url: string;
    usesLeft: number;
}

/** A token is a bearer capability (a minted run may skip its prompt), so only the owner may read the file. */
const TOKEN_FILE_MODE = 0o600;

export function tokenFile(): string {
    return `${new Storage("browser-router").getBaseDir()}/tokens.json`;
}

export function mintToken(url: string, uses: number): string {
    if (!Number.isInteger(uses) || uses < 1) {
        throw new Error("--uses must be a positive integer");
    }

    assertLocked("mintToken");

    const id = randomBytes(9).toString("base64url");
    const all = readTokens();
    all[id] = { url, usesLeft: uses };
    writeTokens(all);
    return id;
}

let lockHolders = 0;

/**
 * Runs `fn` while this process holds the token file lock (O_EXCL, shared with every other process).
 * A check and the spend that follows it must happen in one `fn`: otherwise two clicks on a one-use
 * link can both read `usesLeft: 1` and both run it. `fn` is synchronous, so nothing interleaves.
 */
export async function withTokenLock<T>(fn: () => T): Promise<T> {
    const lock = `${tokenFile()}.lock`;
    mkdirSync(dirname(lock), { recursive: true });

    return withFileLock(lock, async () => {
        lockHolders += 1;

        try {
            return fn();
        } finally {
            lockHolders -= 1;
        }
    });
}

/** Every write to the token file goes through here: an unlocked read-modify-write loses a race. */
function assertLocked(caller: string): void {
    if (lockHolders === 0) {
        throw new Error(`${caller} changes tokens.json and must run inside withTokenLock`);
    }
}

/** Returns the record. When `consume` is set, one use is spent and a spent token is deleted. */
export function takeToken(id: string, consume: boolean): TokenRecord | null {
    const all = readTokens();
    const token = all[id];

    if (!token || token.usesLeft < 1) {
        return null;
    }

    if (!consume) {
        return token;
    }

    assertLocked("takeToken");
    token.usesLeft -= 1;

    if (token.usesLeft < 1) {
        delete all[id];
    } else {
        all[id] = token;
    }

    writeTokens(all);
    return token;
}

function readTokens(): Record<string, TokenRecord> {
    const path = tokenFile();
    let text: string;

    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        logger.debug({ error, path }, "browser-router: no token file yet");
        return {};
    }

    restrictMode(path);

    try {
        const parsed: unknown = SafeJSON.parse(text, { strict: true });

        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return {};
        }

        return parsed as Record<string, TokenRecord>;
    } catch (error) {
        logger.warn({ error, path }, "browser-router: token file is not JSON, treating it as empty");
        return {};
    }
}

/** A file written before tokens were private (a 022 umask made it 0644) is tightened on the next read. */
function restrictMode(path: string): void {
    if (process.platform === "win32") {
        return;
    }

    try {
        if ((statSync(path).mode & 0o077) !== 0) {
            chmodSync(path, TOKEN_FILE_MODE);
        }
    } catch (error) {
        logger.warn({ error, path }, "browser-router: could not restrict the token file mode");
    }
}

function writeTokens(tokens: Record<string, TokenRecord>): void {
    atomicWriteFileSync(tokenFile(), `${SafeJSON.stringify(tokens, null, 2)}\n`, { mode: TOKEN_FILE_MODE });
}
