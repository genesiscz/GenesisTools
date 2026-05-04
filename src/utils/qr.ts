import qrcode from "qrcode-terminal";

export interface QrOptions {
    /** Error correction level. 'L' = ~7%, 'M' = ~15%, 'Q' = ~25%, 'H' = ~30%. Default 'L' for compactness. */
    level?: "L" | "M" | "Q" | "H";
    /** Render in half-block (small) mode. Default true — looks good in modern terminals. */
    small?: boolean;
}

/**
 * Render a QR code for `input` as a string of unicode block characters,
 * suitable for printing to a terminal. Synchronous despite the underlying
 * library's callback API — qrcode-terminal invokes the callback synchronously.
 */
export function renderQr(input: string, opts: QrOptions = {}): string {
    let out = "";
    qrcode.generate(
        input,
        {
            small: opts.small ?? true,
            ...(opts.level && { errorLevel: opts.level }),
        },
        (rendered: string) => {
            out = rendered;
        }
    );
    return out;
}
