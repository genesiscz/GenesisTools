import { randomBytes } from "node:crypto";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { DecisionRecord } from "../decisions/store";
import type { ActReceipt } from "./act";

/** Where an act token is shown: one answer button each. */
export const ACT_SURFACES = ["telegram", "banner", "phone"] as const;
export type ActSurface = (typeof ACT_SURFACES)[number];

/** What one token answers: one option letter of one decision revision. */
export interface ActTokenRecord {
    decisionId: string;
    session: string;
    number: number;
    option: string;
    /** The revision the button showed; a newer post refuses the act ("changed"). */
    revision?: number;
    provider?: string;
    surface: ActSurface;
    issuedAt: number;
    expiresAt: number;
    /** By idempotency key (a Telegram callback id, a phone request id): a retried act returns its first receipt. */
    receipts: Record<string, ActReceipt | { pending: true; at: number }>;
}

export type ActTokenMap = Record<string, ActTokenRecord>;

/** One week: a decision that waited longer is answered in the hub. A token is many-use until the decision closes. */
export const ACT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The token store. The file store is the real one; tests use the memory store. */
export interface ActTokenStore {
    /** Runs `fn` on the map under the store's lock and saves what it left; returns what `fn` returned. */
    update<T>(fn: (tokens: ActTokenMap) => T): Promise<T>;
    /**
     * Whether the token is stored, read without the lock and without a write. `act` asks it first, so an unknown
     * credential (anyone may post one to the public act route) never rewrites the token file.
     */
    has(token: string): Promise<boolean>;
}

const TOKENS_FILE = "act-tokens.json";

/**
 * `~/.genesis-tools/question/cache/act-tokens.json`, under the file lock of `Storage.atomicUpdate`. Owner-only (0600):
 * a token answers a decision without the dashboard login.
 */
export function fileActTokenStore(storage = new Storage("question")): ActTokenStore {
    return {
        async update(fn) {
            let result: ReturnType<typeof fn> | undefined;
            await storage.atomicUpdate<ActTokenMap>(
                TOKENS_FILE,
                (current) => {
                    const tokens = { ...(current ?? {}) };
                    result = fn(tokens);
                    return tokens;
                },
                { mode: 0o600 }
            );
            return result as ReturnType<typeof fn>;
        },
        async has(token) {
            const tokens = await storage.getCacheFile<ActTokenMap>(TOKENS_FILE, "1000 days");
            return Boolean(tokens && Object.hasOwn(tokens, token));
        },
    };
}

export function memoryActTokenStore(initial: ActTokenMap = {}): ActTokenStore & { tokens: ActTokenMap } {
    const tokens = initial;
    return {
        tokens,
        async update(fn) {
            return fn(tokens);
        },
        async has(token) {
            return Object.hasOwn(tokens, token);
        },
    };
}

/** 128 random bits as base64url: 22 characters, so `d:<token>` fits Telegram's 64-byte callback data. */
export function newActToken(): string {
    return randomBytes(16).toString("base64url");
}

function letterAt(index: number): string {
    return String.fromCharCode(97 + index);
}

/**
 * One token per option letter of `row`, stored for `surface`. Expired tokens are dropped on the same write, so the
 * file holds only live buttons.
 */
export async function issueActTokens({
    row,
    surface,
    store = fileActTokenStore(),
    now = Date.now(),
    newToken = newActToken,
}: {
    row: Pick<DecisionRecord, "id" | "sessionId" | "number" | "options" | "revision" | "provider">;
    surface: ActSurface;
    store?: ActTokenStore;
    now?: number;
    newToken?: () => string;
}): Promise<{ letter: string; token: string }[]> {
    const issued = row.options.map((_, index) => ({ letter: letterAt(index), token: newToken() }));

    await store.update((tokens) => {
        for (const [token, record] of Object.entries(tokens)) {
            if (record.expiresAt <= now) {
                delete tokens[token];
            }
        }

        for (const { letter, token } of issued) {
            tokens[token] = {
                decisionId: row.id,
                session: row.sessionId,
                number: row.number,
                option: letter,
                // A row with no revision is revision 1 everywhere else, so an older button refuses a re-posted text.
                revision: row.revision ?? 1,
                ...(row.provider ? { provider: row.provider } : {}),
                surface,
                issuedAt: now,
                expiresAt: now + ACT_TOKEN_TTL_MS,
                receipts: {},
            };
        }
    });

    return issued;
}
