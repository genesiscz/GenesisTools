import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage, withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

export interface TokenRecord {
    /** The URL a click routes. In a bundle it is the first of `urls`, so an older reader still gets a link. */
    url: string;
    usesLeft: number;
    /** A bundle: one click opens every URL and spends one use. Absent on a single-link token. */
    urls?: string[];
}

/** A token is a bearer capability (a minted run may skip its prompt), so only the owner may read the file. */
const TOKEN_FILE_MODE = 0o600;
const TOKEN_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function tokenFile(): string {
    return `${new Storage("browser-router").getBaseDir()}/tokens.json`;
}

/** A fresh id for `https://genesis.tools/t/<id>`: 72 random bits. */
export function newTokenId(): string {
    return randomBytes(9).toString("base64url");
}

/** `id` lets a caller print the link before the record is written (`planMintedLink`). */
export function mintToken(url: string, uses: number, id: string = newTokenId()): string {
    return writeToken(id, { url, usesLeft: checkedUses(uses) });
}

/** One link that opens every URL in `urls` on one click. */
export function mintBundleToken(urls: string[], uses: number, id: string = newTokenId()): string {
    const [first] = urls;

    if (!first) {
        throw new Error("a bundle needs at least one link");
    }

    return writeToken(id, { url: first, usesLeft: checkedUses(uses), urls: [...urls] });
}

function checkedUses(uses: number): number {
    if (!Number.isInteger(uses) || uses < 1) {
        throw new Error("--uses must be a positive integer");
    }

    return uses;
}

function writeToken(id: string, record: TokenRecord): string {
    if (!TOKEN_ID.test(id)) {
        throw new Error(`token id ${id} is not 8 to 64 letters, digits, _ or -`);
    }

    assertLocked("mintToken");

    const all = readTokens();

    if (all[id]) {
        throw new Error(`token ${id} already exists`);
    }

    all[id] = record;
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
