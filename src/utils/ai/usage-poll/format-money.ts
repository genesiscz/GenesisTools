import type { LimitWindow } from "@genesiscz/utils/ai/providers/account-features";

/**
 * `9.00 / 30.00 USD`, or `9.00 USD` when the window has no limit. The divisor is the
 * currency's own exponent, not a fixed 2: a three-decimal currency (KWD, BHD) would
 * otherwise lose its last minor-unit digit. Shared by the Ink dashboard and the
 * `tools ai accounts show` line; it lives here so a CLI door can import it without
 * pulling Ink and React into its startup.
 */
export function formatMoney(window: LimitWindow): string | null {
    if (!window.money) {
        return null;
    }

    const { usedMinor, limitMinor, currency, exponent } = window.money;
    const divisor = 10 ** exponent;
    const used = (usedMinor / divisor).toFixed(exponent);

    if (limitMinor === undefined) {
        return `${used} ${currency}`;
    }

    return `${used} / ${(limitMinor / divisor).toFixed(exponent)} ${currency}`;
}
