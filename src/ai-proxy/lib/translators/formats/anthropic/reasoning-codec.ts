import {
    openReasoningEnvelope,
    packReasoningEnvelope,
    type ReasoningEnvelopeStamp,
} from "@app/ai-proxy/lib/translators/formats/anthropic/reasoning-envelope";

type JsonRecord = Record<string, unknown>;

/**
 * How one provider carries a Responses reasoning item through Claude Code. The Anthropic wire has no slot for it, so it
 * rides inside a thinking block's `signature`, which Claude Code sends back unread. `seal` makes that signature from
 * an item the upstream returned; `open` turns a thinking block of a later request back into the item, or says why it
 * cannot (another provider's block, another login's, a damaged one).
 */
export interface ReasoningCodec {
    open(thinking: JsonRecord): { ok: true; item: JsonRecord } | { ok: false; reason: string };
    /** The signature for a reasoning item; "" when it carries nothing to replay. */
    seal(item: JsonRecord): string;
}

export const REASONING_SIGNATURE_PREFIX = "grokrs1:";

export function packReasoningSignature(id: string, encryptedContent: string): string {
    return `${REASONING_SIGNATURE_PREFIX}${id}:${encryptedContent}`;
}

export function unpackReasoningSignature(signature: unknown): { id: string; encryptedContent: string } | undefined {
    if (typeof signature !== "string" || !signature.startsWith(REASONING_SIGNATURE_PREFIX)) {
        return undefined;
    }

    const rest = signature.slice(REASONING_SIGNATURE_PREFIX.length);
    const separator = rest.indexOf(":");

    if (separator <= 0 || separator === rest.length - 1) {
        return undefined;
    }

    return { id: rest.slice(0, separator), encryptedContent: rest.slice(separator + 1) };
}

function itemId(item: JsonRecord): string {
    return typeof item.id === "string" ? item.id : `rs_${crypto.randomUUID()}`;
}

/** Grok: `grokrs1:<id>:<encrypted>`; the thinking text is the summary. xAI decrypts and consumes it on replay. */
export const grokReasoningCodec: ReasoningCodec = {
    open(thinking) {
        const packed = unpackReasoningSignature(thinking.signature);

        if (packed === undefined) {
            return { ok: false, reason: "not-grok" };
        }

        return {
            ok: true,
            item: {
                type: "reasoning",
                id: packed.id,
                summary: [{ type: "summary_text", text: String(thinking.thinking ?? "") }],
                encrypted_content: packed.encryptedContent,
            },
        };
    },
    seal(item) {
        if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
            return "";
        }

        return packReasoningSignature(itemId(item), item.encrypted_content);
    },
};

/** Codex: a `gtr1` envelope stamped with the provider, the login and the model family (see reasoning-envelope.ts). */
export function codexReasoningCodec(stamp: ReasoningEnvelopeStamp): ReasoningCodec {
    return {
        open(thinking) {
            const opened = openReasoningEnvelope(thinking.signature, stamp);
            return opened.ok ? { ok: true, item: { type: "reasoning", ...opened.item } } : opened;
        },
        seal(item) {
            if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
                return "";
            }

            return packReasoningEnvelope(stamp, {
                id: itemId(item),
                encrypted_content: item.encrypted_content,
                summary: Array.isArray(item.summary) ? item.summary : [],
            });
        },
    };
}
