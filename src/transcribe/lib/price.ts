import { type QuoteChoice, speechModelMatches, type TranscriptionQuote } from "@genesiscz/utils/ai/catalog/speech";

/** Available providers first, then cheapest known price. Stream sits beside its batch twin. */
export function orderQuotes(quotes: TranscriptionQuote[], available: ReadonlySet<string>): TranscriptionQuote[] {
    return [...quotes].sort((left, right) => {
        const leftReady = available.has(left.provider) ? 0 : 1;
        const rightReady = available.has(right.provider) ? 0 : 1;

        if (leftReady !== rightReady) {
            return leftReady - rightReady;
        }

        if (left.usd === null && right.usd === null) {
            return left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model);
        }

        if (left.usd === null) {
            return 1;
        }

        if (right.usd === null) {
            return -1;
        }

        if (left.usd !== right.usd) {
            return left.usd - right.usd;
        }

        return (
            left.provider.localeCompare(right.provider) ||
            left.model.localeCompare(right.model) ||
            left.mode.localeCompare(right.mode)
        );
    });
}

/**
 * `default` when no provider was named and this is what that provider would use.
 * `yes` when `--provider` (and `--model`, if passed) selects this batch row.
 */
export function runLabel(quote: TranscriptionQuote, choice?: QuoteChoice): string {
    if (!choice?.provider) {
        return quote.transcribeDefault && quote.mode === "batch" ? "default" : "";
    }

    if (quote.provider !== choice.provider || quote.mode !== "batch") {
        return "";
    }

    if (!choice.model) {
        return quote.transcribeDefault ? "yes" : "";
    }

    return speechModelMatches(quote, choice.provider, choice.model) ? "yes" : "";
}

export function formatUsd(amount: number | null): string {
    if (amount === null) {
        return "—";
    }

    if (amount === 0) {
        return "$0";
    }

    return `$${amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}
