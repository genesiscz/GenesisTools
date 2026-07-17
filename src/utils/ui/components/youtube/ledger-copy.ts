/**
 * Human-facing copy for credit-ledger reasons (spec §7: "register-grant" etc →
 * user-friendly labels; add context to each activity row). Pure and
 * browser-safe so both the extension activity view and the web account page
 * render the same wording. The raw reason strings are the `CreditReason` union
 * in `users.types.ts`; anything unrecognized falls back to a de-slugged label
 * so a new reason never shows as a bare machine token.
 */
export interface LedgerReasonCopy {
    label: string;
    /** One-line context shown under the label, when it adds meaning. */
    detail?: string;
}

const EXACT_LABELS: Record<string, LedgerReasonCopy> = {
    "register-grant": { label: "Welcome bonus", detail: "Diamonds to get you started" },
    ask: { label: "Question", detail: "Asked about a video" },
    "qa:channel": { label: "Channel question", detail: "Asked across a channel" },
    "summary:long": { label: "Full summary" },
    "summary:timestamped": { label: "Timestamped insights" },
    "summary:short": { label: "Quick summary" },
    "transcript:translate": { label: "Transcript translation" },
    "transcribe:ai": { label: "AI transcription", detail: "Generated captions from audio" },
    "dev-topup": { label: "Top-up", detail: "Developer grant" },
};

/** Prefix (segment before the first `:`) → copy, for id-suffixed reasons. */
const PREFIX_LABELS: Record<string, LedgerReasonCopy> = {
    stripe: { label: "Diamond pack", detail: "Purchase" },
    "stripe-refund": { label: "Refund", detail: "Purchase refunded" },
    refund: { label: "Refund" },
    hold: { label: "Reserved", detail: "Held for a pending action" },
    "hold-release": { label: "Refund", detail: "Reservation released" },
    "sub-allowance": { label: "Monthly allowance", detail: "Subscription reset" },
    reuse: { label: "Unlocked", detail: "Instant reuse of a shared result" },
    report: { label: "Multi-video report" },
    tts: { label: "Audio summary" },
};

export function formatLedgerReason(reason: string): LedgerReasonCopy {
    const exact = EXACT_LABELS[reason];

    if (exact) {
        return exact;
    }

    // Referral reasons carry a side segment: `referral:<id>:referrer|referee`.
    if (reason.startsWith("referral:")) {
        return reason.endsWith(":referrer")
            ? { label: "Referral reward", detail: "A friend you invited joined" }
            : { label: "Referral bonus", detail: "Welcome reward for using an invite" };
    }

    const prefix = reason.includes(":") ? reason.slice(0, reason.indexOf(":")) : reason;
    const known = PREFIX_LABELS[prefix];

    if (known) {
        return known;
    }

    return { label: deslug(prefix) };
}

/** "some-machine_token" → "Some machine token" — the last-resort label. */
function deslug(value: string): string {
    const words = value.replace(/[-_]+/g, " ").trim();

    if (words === "") {
        return "Activity";
    }

    return words.charAt(0).toUpperCase() + words.slice(1);
}
