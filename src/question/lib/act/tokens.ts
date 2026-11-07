import { randomBytes } from "node:crypto";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { DecisionRecord } from "../decisions/store";
import type { PressReceipt } from "./act";

/** Where an act token is shown: one answer button each. */
export const ACT_SURFACES = ["telegram", "banner", "phone"] as const;
export type ActSurface = (typeof ACT_SURFACES)[number];

/**
 * What a press of a token's button does. `answer` answers with the token's `option` (one letter, or a set like "ac"),
 * or with the act's text for a reply token. A decision that takes several letters gets `toggle` buttons, which add
 * their letter to the decision's staged pick (`draftOption`) or take it out, and one `send` button, which answers with
 * the staged letters.
 */
export const ACT_TOKEN_KINDS = ["answer", "toggle", "send"] as const;
export type ActTokenKind = (typeof ACT_TOKEN_KINDS)[number];

/** What one token does for one decision revision. */
export interface ActTokenRecord {
    decisionId: string;
    session: string;
    number: number;
    /** The answer of an `answer` token, the letter of a `toggle` token; empty for `send` and reply tokens. */
    option: string;
    /** Absent is `answer`: every token stored before the kinds existed answers with its letter, as it always did. */
    kind?: ActTokenKind;
    /** The toggle and send tokens of one keyboard share it, so a toggle can redraw that keyboard with its tokens. */
    group?: string;
    /** A reply token answers with the text the act carries, not with `option` (the lock screen's Reply field). */
    reply?: true;
    /** The revision the button showed; a newer post refuses the act ("changed"). */
    revision?: number;
    provider?: string;
    surface: ActSurface;
    issuedAt: number;
    expiresAt: number;
    /** By idempotency key (a Telegram callback id, a phone request id): a retried act returns its first receipt. */
    receipts: Record<string, PressReceipt | { pending: true; at: number }>;
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
    /** The whole map, read without the lock and without a write (a keyboard redraw reads its group's tokens). */
    read(): Promise<ActTokenMap>;
}

/** What a token record does when pressed; a record from before the kinds is an `answer`. */
export function tokenKind(record: Pick<ActTokenRecord, "kind">): ActTokenKind {
    return record.kind ?? "answer";
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
        async read() {
            return (await storage.getCacheFile<ActTokenMap>(TOKENS_FILE, "1000 days")) ?? {};
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
        async read() {
            return tokens;
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

type TokenRow = Pick<DecisionRecord, "id" | "sessionId" | "number" | "revision" | "provider">;

/** What one new token stands for; the decision, the surface and the dates come from `storeTokens`. */
type TokenPart = Pick<ActTokenRecord, "option"> & Partial<Pick<ActTokenRecord, "kind" | "group" | "reply">>;

/**
 * Stores one record per `[token, part]` for `row` on `surface`. Expired tokens are dropped on the same write, so the
 * file holds only live buttons.
 */
async function storeTokens({
    row,
    surface,
    store,
    now,
    parts,
}: {
    row: TokenRow;
    surface: ActSurface;
    store: ActTokenStore;
    now: number;
    parts: [string, TokenPart][];
}): Promise<void> {
    await store.update((tokens) => {
        for (const [token, record] of Object.entries(tokens)) {
            if (record.expiresAt <= now) {
                delete tokens[token];
            }
        }

        for (const [token, part] of parts) {
            tokens[token] = {
                decisionId: row.id,
                session: row.sessionId,
                number: row.number,
                ...part,
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
}

/** One token per option letter of `row`, stored for `surface`; each answers with its letter. */
export async function issueActTokens({
    row,
    surface,
    store = fileActTokenStore(),
    now = Date.now(),
    newToken = newActToken,
}: {
    row: TokenRow & Pick<DecisionRecord, "options">;
    surface: ActSurface;
    store?: ActTokenStore;
    now?: number;
    newToken?: () => string;
}): Promise<{ letter: string; token: string }[]> {
    const issued = row.options.map((_, index) => ({ letter: letterAt(index), token: newToken() }));
    await storeTokens({
        row,
        surface,
        store,
        now,
        parts: issued.map(({ letter, token }) => [token, { option: letter }]),
    });
    return issued;
}

/** One token that answers `row` with `option` (a set like "abc": the banner's recommended-set button). */
export async function issueAnswerToken({
    row,
    option,
    surface,
    store = fileActTokenStore(),
    now = Date.now(),
    newToken = newActToken,
}: {
    row: TokenRow;
    option: string;
    surface: ActSurface;
    store?: ActTokenStore;
    now?: number;
    newToken?: () => string;
}): Promise<string> {
    const token = newToken();
    await storeTokens({ row, surface, store, now, parts: [[token, { option }]] });
    return token;
}

/** The buttons of a decision that takes several letters: one toggle per letter and the send button. */
export interface ToggleTokens {
    letters: { letter: string; token: string }[];
    send: string;
    group: string;
}

/**
 * A toggle token per letter of `count` and one send token, all in one group, stored for `surface`. A toggle adds its
 * letter to the staged pick or takes it out; the send answers with the staged letters (`act`).
 */
export async function issueToggleTokens({
    row,
    count,
    surface,
    store = fileActTokenStore(),
    now = Date.now(),
    newToken = newActToken,
}: {
    row: TokenRow;
    /** How many letters the decision shows (`decisionOptionLabels`). */
    count: number;
    surface: ActSurface;
    store?: ActTokenStore;
    now?: number;
    newToken?: () => string;
}): Promise<ToggleTokens> {
    const letters = Array.from({ length: count }, (_, index) => ({ letter: letterAt(index), token: newToken() }));
    const send = newToken();
    // The send token names its group: it is as unguessable as any token, and one keyboard has exactly one.
    const group = send;
    await storeTokens({
        row,
        surface,
        store,
        now,
        parts: [
            ...letters.map(({ letter, token }): [string, TokenPart] => [
                token,
                { option: letter, kind: "toggle", group },
            ]),
            [send, { option: "", kind: "send", group }],
        ],
    });
    return { letters, send, group };
}

/** The toggle and send tokens of `group`, as `issueToggleTokens` returned them; null when any of them is gone. */
export function toggleTokensOf(tokens: ActTokenMap, group: string): ToggleTokens | null {
    const members = Object.entries(tokens).filter(([, record]) => record.group === group);
    const send = members.find(([, record]) => tokenKind(record) === "send")?.[0];
    const letters = members
        .filter(([, record]) => tokenKind(record) === "toggle")
        .map(([token, record]) => ({ letter: record.option, token }))
        .sort((a, b) => a.letter.localeCompare(b.letter));

    return send && letters.length > 0 ? { letters, send, group } : null;
}

/** One token that answers `row` with free text (the notification's Reply field), stored for `surface`. */
export async function issueReplyToken({
    row,
    surface,
    store = fileActTokenStore(),
    now = Date.now(),
    newToken = newActToken,
}: {
    row: TokenRow;
    surface: ActSurface;
    store?: ActTokenStore;
    now?: number;
    newToken?: () => string;
}): Promise<string> {
    const token = newToken();
    await storeTokens({ row, surface, store, now, parts: [[token, { option: "", reply: true }]] });
    return token;
}
