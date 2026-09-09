import type { LimitWindow } from "@genesiscz/utils/ai/providers/account-features";

/**
 * `9.00 / 30.00 USD`, or `9.00 USD` when the window has no limit. The divisor is the
 * currency's own exponent, not a fixed 2: a three-decimal currency (KWD, BHD) would
 * otherwise lose its last minor-unit digit. Shared by the Ink dashboard and the
 * `tools ai accounts show` line; it lives here so a CLI door can import it without
 * pulling Ink and React into its startup.
 */
function amount(minor: number, exponent: number): string {
    return (minor / 10 ** exponent).toFixed(Math.max(0, exponent));
}

export function formatMoney(window: LimitWindow): string | null {
    if (!window.money) {
        return null;
    }

    const { usedMinor, limitMinor, limitExponent, capMinor, capCurrency, currency, exponent } = window.money;
    const used = amount(usedMinor, exponent);

    // `limitExponent` exists because a provider may state the limit's exponent separately from
    // the spend's. `record.ts` already stores `limitExponent ?? exponent`, and the claude-only
    // door (`formatSpendBalance`) already prints it, so ignoring it here made the two doors
    // disagree about the same account by a power of ten.
    if (limitMinor !== undefined) {
        return `${used} / ${amount(limitMinor, limitExponent ?? exponent)} ${currency}`;
    }

    // No limit but a configured ceiling: `formatSpendBalance` shows the cap here, and printing
    // the bare spend instead read as "no ceiling at all" for an account that has one.
    if (capMinor !== undefined) {
        return `${used} / ${amount(capMinor, exponent)} ${capCurrency ?? currency}`;
    }

    return `${used} ${currency}`;
}

/**
 * `percentUsed` as a number a renderer can print.
 *
 * The field is declared `number`, and every WRITER guards it (`record.ts`, `use-poller.ts`,
 * `poll-daemon.ts` all skip a window whose value is not finite). No renderer did, and they are
 * the ones that call `.toFixed`. The gap is not theoretical: `snapshots.json` is cast back with
 * no validation and holds rows for a year, so a row a pre-fix build wrote without the field
 * (grok's untouched product window, issue 5ee4db79d) still crashes `tools ai accounts show`,
 * which reads that file and never polls.
 */
export function percentOf(window: { percentUsed?: number }): number {
    return typeof window.percentUsed === "number" && Number.isFinite(window.percentUsed) ? window.percentUsed : 0;
}
