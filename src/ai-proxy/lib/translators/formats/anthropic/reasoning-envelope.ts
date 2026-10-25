/**
 * The Codex agent's reasoning, carried through Claude Code inside a thinking block's `signature`, which Claude Code
 * replays verbatim and never reads. Versioned and stamped by its producer, so a later turn replays only what the same
 * kind of upstream, the same account and a compatible model produced:
 *
 *   gtr1.<provider>.<accountHash8>.<model>.<compHash>.<base64url(JSON {id, encrypted_content, summary})>
 *
 * The model id may hold dots (`gpt-6.1-sol`); every other field has none, so it is read from both ends. A
 * signature that fails a check is dropped silently: answering 400 about a thinking block makes Claude Code strip
 * every thinking block and retry.
 */
import { createHash } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";

export const REASONING_ENVELOPE_VERSION = "gtr1";

export interface ReasoningEnvelopeStamp {
    /** The upstream kind that produced the item (`codex`). */
    provider: string;
    /** First 8 hex of the SHA-256 of the account identity that produced it (never the identity itself). */
    accountHash: string;
    model: string;
    /** The model family's reasoning compatibility hash (catalog `comp_hash`); items replay across one hash only. */
    compHash: string;
}

/** A Responses `reasoning` item, whole: what is sent back upstream. */
export interface ReplayedReasoning {
    id: string;
    encrypted_content: string;
    summary: unknown[];
}

export type EnvelopeRejection = "not-envelope" | "malformed" | "provider" | "account" | "comp-hash";

export type EnvelopeCheck =
    | { ok: true; item: ReplayedReasoning; stamp: ReasoningEnvelopeStamp }
    | { ok: false; reason: EnvelopeRejection };

export function accountHash8(identity: string): string {
    return createHash("sha256").update(identity).digest("hex").slice(0, 8);
}

export function packReasoningEnvelope(stamp: ReasoningEnvelopeStamp, item: ReplayedReasoning): string {
    const payload = Buffer.from(SafeJSON.stringify(item)).toString("base64url");
    return [REASONING_ENVELOPE_VERSION, stamp.provider, stamp.accountHash, stamp.model, stamp.compHash, payload].join(
        "."
    );
}

function parsePayload(payload: string): ReplayedReasoning | undefined {
    try {
        const value = SafeJSON.parse(Buffer.from(payload, "base64url").toString("utf8"), { strict: true });

        if (
            isObject(value) &&
            typeof value.id === "string" &&
            typeof value.encrypted_content === "string" &&
            value.encrypted_content.length > 0
        ) {
            return {
                id: value.id,
                encrypted_content: value.encrypted_content,
                summary: Array.isArray(value.summary) ? value.summary : [],
            };
        }
    } catch {
        // A truncated or edited signature: dropped like any other that fails a check.
    }

    return undefined;
}

/** Opens a signature and checks it against what the next request may replay: same provider, account and comp_hash. */
export function openReasoningEnvelope(
    signature: unknown,
    expect: Omit<ReasoningEnvelopeStamp, "model">
): EnvelopeCheck {
    if (typeof signature !== "string" || !signature.startsWith(`${REASONING_ENVELOPE_VERSION}.`)) {
        return { ok: false, reason: "not-envelope" };
    }

    const parts = signature.split(".");

    if (parts.length < 6) {
        return { ok: false, reason: "malformed" };
    }

    const [, provider, accountHash] = parts;
    const payload = parts.at(-1) ?? "";
    const compHash = parts.at(-2) ?? "";
    const stamp = { provider, accountHash, model: parts.slice(3, -2).join("."), compHash };

    if (provider !== expect.provider) {
        return { ok: false, reason: "provider" };
    }

    if (accountHash !== expect.accountHash) {
        return { ok: false, reason: "account" };
    }

    if (compHash !== expect.compHash) {
        return { ok: false, reason: "comp-hash" };
    }

    const item = parsePayload(payload);
    return item ? { ok: true, item, stamp } : { ok: false, reason: "malformed" };
}

/** A 400 that rejects replayed reasoning (another account's blob, a stale one): retried once without it. */
const REPLAY_REJECTED = [
    /invalid_encrypted_content/i,
    /could not be verified/i,
    /could not decrypt/i,
    /was not issued to this caller/i,
    /unsupported content type/i,
];

export function isReasoningReplayRejection(status: number, bodyText: string): boolean {
    return status === 400 && REPLAY_REJECTED.some((pattern) => pattern.test(bodyText));
}
